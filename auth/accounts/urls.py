from django.urls import path

from . import views

urlpatterns = [
    path('csrf', views.csrf, name='csrf'),
    path('config', views.config, name='config'),
    path('me', views.me, name='me'),
    path('executor-token', views.executor_token, name='executor-token'),
    path('jwks', views.jwks, name='jwks'),
]
