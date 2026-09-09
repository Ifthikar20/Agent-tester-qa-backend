"""
A mail rendered from a template pair, with or without a request.

allauth's adapter renders `<prefix>_subject.txt` and `<prefix>_message.txt`
and needs the current request to name the site. The mails this project adds
— an invitation, a new-device notice, "nobody invited you" — are sometimes
sent from code with no request in hand (a management command, a receiver
called from a test), so this renders the same pair the same way and asks
for nothing. The templates say "ghostclick" rather than reading a site
name, because there is one product and its name is not a setting.
"""
from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string


def send(prefix, to, context=None):
    context = {'email': to, **(context or {})}
    subject = ' '.join(render_to_string(f'{prefix}_subject.txt', context).splitlines()).strip()
    prefix_text = getattr(settings, 'ACCOUNT_EMAIL_SUBJECT_PREFIX', '')
    if prefix_text and not subject.startswith(prefix_text):
        subject = f'{prefix_text}{subject}'
    body = render_to_string(f'{prefix}_message.txt', context).strip()
    EmailMultiAlternatives(subject, body, settings.DEFAULT_FROM_EMAIL, [to]).send()
