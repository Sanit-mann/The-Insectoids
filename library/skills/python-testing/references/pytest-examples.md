# pytest examples

Examples for [python-testing](../SKILL.md).

## Fixtures

```python
import pytest


@pytest.fixture
def user():
    return User(id=1, name="Alice", role="member")


@pytest.fixture
def db(engine):                          # function scope on top of a session-scoped engine
    conn = engine.connect()
    tx = conn.begin()
    yield conn
    tx.rollback()                         # runs even when the test fails
    conn.close()


@pytest.fixture
def make_order():                         # factory fixture
    def _make(total: int = 100, status: str = "pending") -> Order:
        return Order(total=total, status=status)
    return _make


def test_cancel_paid_order_refunds(make_order):
    order = make_order(status="paid")

    order.cancel()

    assert order.refund_issued
```

Built-ins:

```python
def test_writes_report(tmp_path):
    out = tmp_path / "report.csv"
    write_report(out, rows=[("a", 1)])
    assert out.read_text() == "a,1\n"


def test_reads_api_key_from_env(monkeypatch):
    monkeypatch.setenv("API_KEY", "test-key")
    assert load_settings().api_key == "test-key"


def test_logs_warning_on_retry(caplog):
    with caplog.at_level("WARNING"):
        fetch_with_retry(flaky_source)
    assert "retrying" in caplog.text
```

## Parametrize

```python
@pytest.mark.parametrize(
    "email, valid",
    [
        ("a@example.com", True),
        ("no-at-sign", False),
        ("@no-local.com", False),
        ("", False),
        pytest.param("ü@example.com", True, marks=pytest.mark.xfail(reason="IDN not supported yet")),
    ],
    ids=["valid", "missing-at", "missing-local", "empty", "unicode"],
)
def test_is_valid_email(email, valid):
    assert is_valid_email(email) is valid


@pytest.fixture(params=["memory", "postgres"])
def repo(request, pg_conn):
    return InMemoryRepo() if request.param == "memory" else PgRepo(pg_conn)
```

## Exceptions

```python
def test_withdraw_more_than_balance_raises():
    account = Account(balance=10)

    with pytest.raises(InsufficientFunds, match="balance 10") as exc_info:
        account.withdraw(50)

    assert exc_info.value.shortfall == 40
```

## Mocking at boundaries

Prefer a fake injected through the constructor:

```python
class FakeMailer:
    def __init__(self):
        self.sent: list[tuple[str, str]] = []

    def send(self, to: str, subject: str) -> None:
        self.sent.append((to, subject))


def test_signup_sends_welcome_email():
    mailer = FakeMailer()
    service = SignupService(mailer=mailer)

    service.signup("a@example.com")

    assert mailer.sent == [("a@example.com", "Welcome")]
```

When you must patch, patch where the name is looked up and use autospec:

```python
from unittest.mock import patch

# myapp/services.py does: from myapp.payments import charge
@patch("myapp.services.charge", autospec=True)
def test_checkout_charges_total(charge_mock):
    charge_mock.return_value = ChargeResult(ok=True)

    checkout(cart_with_total(250))

    charge_mock.assert_called_once_with(amount=250, currency="EUR")


@patch("myapp.services.charge", autospec=True)
def test_checkout_surfaces_payment_failure(charge_mock):
    charge_mock.side_effect = PaymentDeclined("card declined")

    with pytest.raises(CheckoutFailed):
        checkout(cart_with_total(250))
```

Async target (patch creates an `AsyncMock`):

```python
@patch("myapp.client.fetch_profile", autospec=True)
async def test_profile_cached(fetch_mock):
    fetch_mock.return_value = {"id": 1}

    await get_profile(1)
    await get_profile(1)

    fetch_mock.assert_awaited_once_with(1)
```

## Async tests and ASGI apps

```python
# pyproject.toml: [tool.pytest.ini_options] asyncio_mode = "auto"
import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    app = create_app()
    async with LifespanManager(app) as manager:          # runs startup/shutdown
        async with AsyncClient(
            transport=ASGITransport(app=manager.app), base_url="http://test"
        ) as c:
            yield c


async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200
```

## Database isolation (SQLAlchemy 2.x)

Roll back everything a test did, even if the code under test calls `commit()`:

```python
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session


@pytest.fixture(scope="session")
def engine():
    eng = create_engine(TEST_DATABASE_URL)     # same engine type as production
    Base.metadata.create_all(eng)              # or run migrations
    yield eng
    eng.dispose()


@pytest.fixture
def session(engine):
    with engine.connect() as conn:
        tx = conn.begin()
        s = Session(bind=conn, join_transaction_mode="create_savepoint")
        yield s
        s.close()
        tx.rollback()
```

## Test classes

```python
class TestCalculator:
    @pytest.fixture
    def calc(self):
        return Calculator()

    def test_add(self, calc):
        assert calc.add(2, 3) == 5

    def test_divide_by_zero(self, calc):
        with pytest.raises(ZeroDivisionError):
            calc.divide(10, 0)
```

## Layout

```text
tests/
├── conftest.py          # fixtures shared by all tests
├── unit/
├── integration/
│   └── conftest.py      # DB / container fixtures
└── e2e/
```

## Configuration

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = ["--strict-markers", "--strict-config", "-ra"]
asyncio_mode = "auto"                     # only if pytest-asyncio is used
markers = [
    "unit: fast, isolated tests",
    "integration: needs a database or other service",
    "slow: takes more than a second",
]
filterwarnings = ["error::DeprecationWarning:myapp.*"]

[tool.coverage.run]
branch = true
source = ["mypackage"]

[tool.coverage.report]
show_missing = true
fail_under = 80
```
