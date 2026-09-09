from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0003_alter_authevent_kind'),
    ]

    operations = [
        migrations.AlterField(
            model_name='authevent',
            name='kind',
            field=models.CharField(choices=[
                ('login', 'signed in'), ('logout', 'signed out'), ('login_failed', 'sign-in refused'),
                ('session_expired', 'session past its absolute lifetime'),
                ('invitation_sent', 'invitation issued'), ('invitation_accepted', 'invitation accepted'),
                ('invitation_refused', 'invitation refused'),
                ('mint', 'executor token minted'), ('mint_refused', 'executor token refused'),
                ('signup', 'signed up'), ('signup_refused', 'sign-up refused'),
                ('email_verified', 'email address verified'), ('reauthentication', 'reauthenticated'),
                ('password_changed', 'password changed'),
                ('password_reset_requested', 'password reset requested'), ('password_reset', 'password reset'),
                ('password_pwned', 'password known to Have I Been Pwned'),
                ('email_changed', 'email address changed'), ('new_device', 'signed in from an unseen device'),
                ('turnstile_demanded', 'address must now solve Turnstile'),
            ], db_index=True, max_length=32),
        ),
        migrations.CreateModel(
            name='PreviousEmail',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('email', models.EmailField(db_index=True, max_length=254)),
                ('replaced_by', models.EmailField(max_length=254)),
                ('replaced_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('until', models.DateTimeField(db_index=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='previous_emails', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['-replaced_at']},
        ),
    ]
