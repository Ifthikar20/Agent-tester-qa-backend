from django.urls import path

from . import views

urlpatterns = [
    path('org', views.switch, name='org-switch'),
    path('invitations', views.invitation_list, name='invitations'),
    path('invitations/accept', views.invitation_accept, name='invitation-accept'),
    path('invitations/<int:pk>', views.invitation_revoke, name='invitation-revoke'),
]
