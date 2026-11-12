# FastAPI worked example

A small users service for [fastapi-patterns](../SKILL.md). Library choices (PyJWT, pwdlib, SQLAlchemy 2.x async) reflect the FastAPI docs as of 2025; keep what the project already uses.

## app/config.py

```python
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    app_name: str = "users-service"
    database_url: str                      # required: no default
    secret_key: str                        # required: no default
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    allowed_origins: list[str] = ["http://localhost:3000"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

## app/database.py

```python
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass
```

## app/main.py

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.database import engine
from app.errors import register_exception_handlers
from app.routers import users


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield                                  # schema is managed by migrations, not create_all()
    await engine.dispose()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    register_exception_handlers(app)
    app.include_router(users.router, prefix="/users", tags=["users"])
    return app


app = create_app()
```

## app/schemas/user.py

```python
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    username: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=12, max_length=128)
    password_confirm: str

    @model_validator(mode="after")
    def passwords_match(self) -> "UserCreate":
        if self.password != self.password_confirm:
            raise ValueError("passwords do not match")
        return self


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str | None = Field(default=None, min_length=3, max_length=50)
    email: EmailStr | None = None


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    username: str
    is_active: bool
    created_at: datetime


class UserPage(BaseModel):
    total: int
    items: list[UserResponse]
```

## app/errors.py

```python
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)


class AppError(Exception):
    status_code = 500
    code = "INTERNAL_ERROR"


class NotFoundError(AppError):
    status_code, code = 404, "NOT_FOUND"


class ConflictError(AppError):
    status_code, code = 409, "CONFLICT"


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": str(exc) or exc.code}},
        )

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "INTERNAL_ERROR", "message": "An unexpected error occurred"}},
        )
```

## app/dependencies.py

```python
from collections.abc import AsyncIterator
from typing import Annotated

import jwt                                       # PyJWT
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.database import SessionLocal
from app.models.user import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/users/token")


async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


SettingsDep = Annotated[Settings, Depends(get_settings)]
DbDep = Annotated[AsyncSession, Depends(get_db)]


async def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)], db: DbDep, settings: SettingsDep
) -> User:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token,
            settings.secret_key,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["exp", "sub"]},
        )
        user_id = int(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        raise unauthorized
    user = await db.get(User, user_id)
    if user is None:
        raise unauthorized
    return user


async def get_current_active_user(
    user: Annotated[User, Depends(get_current_user)],
) -> User:
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user")
    return user


ActiveUserDep = Annotated[User, Depends(get_current_active_user)]
```

## app/services/user_service.py

```python
from datetime import UTC, datetime, timedelta

import jwt
from pwdlib import PasswordHash
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import ConflictError
from app.models.user import User
from app.schemas.user import UserCreate, UserUpdate

password_hash = PasswordHash.recommended()       # Argon2
DUMMY_HASH = password_hash.hash("dummy-password-for-timing")


class UserService:
    def __init__(self, db: AsyncSession, settings: Settings) -> None:
        self.db = db
        self.settings = settings

    async def create(self, data: UserCreate) -> User:
        user = User(
            email=data.email,
            username=data.username,
            hashed_password=password_hash.hash(data.password),
        )
        self.db.add(user)
        try:
            await self.db.commit()               # unique index on email decides, not a pre-check
        except IntegrityError as exc:
            await self.db.rollback()
            raise ConflictError("email already registered") from exc
        await self.db.refresh(user)
        return user

    async def list(self, offset: int, limit: int) -> tuple[list[User], int]:
        total = (await self.db.execute(select(func.count(User.id)))).scalar_one()
        rows = await self.db.execute(
            select(User).order_by(User.id).offset(offset).limit(limit)
        )
        return list(rows.scalars()), total

    async def update(self, user_id: int, data: UserUpdate) -> User | None:
        user = await self.db.get(User, user_id)
        if user is None:
            return None
        for field, value in data.model_dump(exclude_unset=True).items():
            setattr(user, field, value)
        try:
            await self.db.commit()
        except IntegrityError as exc:
            await self.db.rollback()
            raise ConflictError("email already registered") from exc
        await self.db.refresh(user)
        return user

    async def authenticate(self, email: str, password: str) -> str | None:
        user = (
            await self.db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None:
            password_hash.verify(password, DUMMY_HASH)   # same timing as a real check
            return None
        if not password_hash.verify(password, user.hashed_password):
            return None
        expire = datetime.now(UTC) + timedelta(minutes=self.settings.access_token_expire_minutes)
        return jwt.encode(
            {"sub": str(user.id), "exp": expire},
            self.settings.secret_key,
            algorithm=self.settings.jwt_algorithm,
        )
```

## app/routers/users.py

```python
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.security import OAuth2PasswordRequestForm

from app.dependencies import ActiveUserDep, DbDep, SettingsDep
from app.errors import NotFoundError
from app.schemas.user import UserCreate, UserPage, UserResponse, UserUpdate
from app.services.user_service import UserService

router = APIRouter()


@router.post("/", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(payload: UserCreate, db: DbDep, settings: SettingsDep):
    return await UserService(db, settings).create(payload)      # ConflictError -> 409 via handler


@router.get("/me", response_model=UserResponse)
async def read_me(user: ActiveUserDep):
    return user


@router.get("/", response_model=UserPage)
async def list_users(
    db: DbDep,
    settings: SettingsDep,
    _: ActiveUserDep,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
):
    items, total = await UserService(db, settings).list(offset, limit)
    return UserPage(total=total, items=items)


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int, payload: UserUpdate, db: DbDep, settings: SettingsDep, user: ActiveUserDep
):
    if user.id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")
    updated = await UserService(db, settings).update(user_id, payload)
    if updated is None:
        raise NotFoundError("user not found")
    return updated


@router.post("/token")
async def login(
    form: Annotated[OAuth2PasswordRequestForm, Depends()], db: DbDep, settings: SettingsDep
) -> dict[str, str]:
    token = await UserService(db, settings).authenticate(form.username, form.password)
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return {"access_token": token, "token_type": "bearer"}
```

## tests/conftest.py

```python
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.dependencies import get_db
from app.main import create_app

TEST_DATABASE_URL = "postgresql+asyncpg://test:test@localhost:5433/test"  # throwaway test DB

engine = create_async_engine(TEST_DATABASE_URL)
TestSession = async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture(autouse=True)
async def schema():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)   # fine for tests only
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.fixture
async def client():
    app = create_app()

    async def override_get_db():
        async with TestSession() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
async def auth_client(client):
    await client.post("/users/", json={
        "email": "t@example.com", "username": "tester",
        "password": "a-long-password", "password_confirm": "a-long-password",
    })
    r = await client.post("/users/token", data={"username": "t@example.com", "password": "a-long-password"})
    client.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
    return client


async def test_duplicate_email_returns_409(client):
    body = {"email": "d@example.com", "username": "dup", "password": "a-long-password",
            "password_confirm": "a-long-password"}
    assert (await client.post("/users/", json=body)).status_code == 201
    assert (await client.post("/users/", json=body)).status_code == 409


async def test_me_requires_token(client):
    assert (await client.get("/users/me")).status_code == 401
```

Assumes `asyncio_mode = "auto"` in pytest config (see python-testing).
