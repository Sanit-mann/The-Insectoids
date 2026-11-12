# Django examples

Examples for [django-patterns](../SKILL.md). Written for Django 5.x/6.x and DRF 3.15+; check the project's versions.

## Settings split

```python
# config/settings/base.py
from pathlib import Path

import environ

env = environ.Env()
BASE_DIR = Path(__file__).resolve().parent.parent.parent

SECRET_KEY = env("DJANGO_SECRET_KEY")          # raises ImproperlyConfigured if missing
DEBUG = False
ALLOWED_HOSTS: list[str] = []

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "apps.users",
    "apps.products",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

DATABASES = {"default": env.db("DATABASE_URL")}
AUTH_USER_MODEL = "users.User"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REST_FRAMEWORK = {
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 20,
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {"anon": "100/hour", "user": "1000/hour"},
}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}

# config/settings/development.py
from .base import *  # noqa: F403  (settings modules are the accepted exception)

DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1"]
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

# config/settings/production.py: see security-checklist.md
```

## Models

```python
from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.db import models
from django.db.models import Q
from django.utils.text import slugify


class User(AbstractUser):
    email = models.EmailField(unique=True)
    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["username"]

    def __str__(self) -> str:
        return self.email


class ProductQuerySet(models.QuerySet):
    def active(self):
        return self.filter(is_active=True)

    def in_stock(self):
        return self.filter(stock__gt=0)

    def with_relations(self):
        return self.select_related("category").prefetch_related("tags")


class Product(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft"
        LIVE = "live"

    name = models.CharField(max_length=200)
    slug = models.SlugField(max_length=250, unique=True)       # unique => already indexed
    price = models.DecimalField(max_digits=10, decimal_places=2)
    stock = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    is_active = models.BooleanField(default=True)
    category = models.ForeignKey("Category", on_delete=models.PROTECT, related_name="products")
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    tags = models.ManyToManyField("Tag", blank=True, related_name="products")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = ProductQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["category", "is_active"])]
        constraints = [
            models.CheckConstraint(condition=Q(price__gte=0), name="product_price_non_negative"),
        ]

    def __str__(self) -> str:
        return self.name

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = slugify(self.name)
        super().save(*args, **kwargs)
```

## N+1 and bulk work

```python
# Bad: one query per product for category, one per product for tags
for p in Product.objects.all():
    print(p.category.name, [t.name for t in p.tags.all()])

# Good: 2-3 queries total
for p in Product.objects.select_related("category").prefetch_related("tags"):
    print(p.category.name, [t.name for t in p.tags.all()])

# Atomic counter update, no race
Product.objects.filter(pk=pk).update(stock=F("stock") - 1)

# Bulk
Product.objects.bulk_create(products, batch_size=500)
Product.objects.bulk_update(products, ["is_active"], batch_size=500)

# Large scan without loading everything
for p in Product.objects.only("id", "price").iterator(chunk_size=2000):
    ...
```

## Service with transaction, lock and on_commit

```python
from django.db import transaction
from django.db.models import F


class OutOfStock(Exception):
    pass


def place_order(*, user, items: list[tuple[int, int]]) -> "Order":
    with transaction.atomic():
        products = {
            p.pk: p
            for p in Product.objects.select_for_update().filter(pk__in=[pid for pid, _ in items])
        }
        order = Order.objects.create(user=user, status=Order.Status.PENDING)
        for pid, qty in items:
            product = products[pid]
            if product.stock < qty:
                raise OutOfStock(product.slug)          # rolls back everything
            OrderItem.objects.create(order=order, product=product, quantity=qty, price=product.price)
            Product.objects.filter(pk=pid).update(stock=F("stock") - qty)
        transaction.on_commit(lambda: send_order_confirmation.delay(order.pk))
    return order
```

Charge the payment provider outside the locked transaction, then update the order status in a new short transaction. Use an idempotency key with the provider.

## DRF serializers

```python
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers


class ProductSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source="category.name", read_only=True)

    class Meta:
        model = Product
        fields = ["id", "name", "slug", "price", "stock", "category", "category_name", "created_at"]
        read_only_fields = ["id", "slug", "created_at"]

    def validate_price(self, value):
        if value < 0:
            raise serializers.ValidationError("Price cannot be negative.")
        return value


class RegistrationSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, validators=[validate_password])
    password_confirm = serializers.CharField(write_only=True)

    class Meta:
        model = User
        fields = ["email", "username", "password", "password_confirm"]

    def validate(self, data):
        if data["password"] != data["password_confirm"]:
            raise serializers.ValidationError({"password_confirm": "Passwords do not match."})
        return data

    def create(self, validated):
        validated.pop("password_confirm")
        password = validated.pop("password")
        user = User(**validated)
        user.set_password(password)
        user.save()
        return user
```

## DRF viewset with scoped queryset and object permission

```python
from rest_framework import permissions, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response


class IsOwnerOrReadOnly(permissions.BasePermission):
    def has_object_permission(self, request, view, obj):
        return request.method in permissions.SAFE_METHODS or obj.owner_id == request.user.id


class ProductViewSet(viewsets.ModelViewSet):
    serializer_class = ProductSerializer
    permission_classes = [permissions.IsAuthenticated, IsOwnerOrReadOnly]
    filterset_fields = ["category", "status"]
    search_fields = ["name"]
    ordering_fields = ["price", "created_at"]

    def get_queryset(self):
        qs = Product.objects.active().with_relations()
        if self.action in {"update", "partial_update", "destroy"}:
            qs = qs.filter(owner=self.request.user)      # others' objects become 404
        return qs

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)         # never from request data

    @action(detail=False, methods=["get"])
    def mine(self, request):
        page = self.paginate_queryset(self.get_queryset().filter(owner=request.user))
        return self.get_paginated_response(self.get_serializer(page, many=True).data)
```

## Middleware (new style)

```python
import logging
import time
import uuid

log = logging.getLogger("request")


class RequestLogMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        start = time.perf_counter()
        response = self.get_response(request)
        log.info(
            "%s %s %s %.3fs id=%s",
            request.method, request.path, response.status_code,
            time.perf_counter() - start, request.id,
        )
        response["X-Request-ID"] = request.id
        return response
```

## Caching

```python
from django.core.cache import cache
from django.utils.decorators import method_decorator
from django.views.decorators.cache import cache_page


@method_decorator(cache_page(60 * 15), name="dispatch")     # anonymous, identical pages only
class ProductListView(ListView):
    model = Product


def featured_products() -> list[Product]:
    key = "products:featured:v1"
    products = cache.get(key)
    if products is None:
        products = list(Product.objects.active().filter(status="live")[:20])
        cache.set(key, products, timeout=60 * 15)
    return products
```

Template fragment: `{% load cache %}{% cache 500 sidebar request.LANGUAGE_CODE %}...{% endcache %}`.

## Signals (only when decoupling is worth it)

```python
# apps/users/signals.py
from django.db.models.signals import post_save
from django.dispatch import receiver


@receiver(post_save, sender=User)
def create_profile(sender, instance, created, **kwargs):
    if created:
        Profile.objects.create(user=instance)


# apps/users/apps.py
class UsersConfig(AppConfig):
    name = "apps.users"

    def ready(self):
        from . import signals  # noqa: F401
```

## Query count test (pytest-django)

```python
def test_product_list_query_count(api_client, django_assert_max_num_queries, products):
    with django_assert_max_num_queries(4):
        r = api_client.get("/api/products/")
    assert r.status_code == 200
```
