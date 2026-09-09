from django.urls import path

from . import views

urlpatterns = [
    path('csrf', views.csrf, name='csrf'),
    path('login', views.login, name='login'),
    path('logout', views.logout, name='logout'),
    path('me', views.me, name='me'),
    path('executor-token', views.executor_token, name='executor-token'),
    path('jwks', views.jwks, name='jwks'),
]
