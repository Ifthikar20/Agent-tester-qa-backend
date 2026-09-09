"""
The control plane's own checks, one module per concern.

    python manage.py test

What is NOT here: whether the runner accepts what this mints. That crosses a
language boundary and neither project can assert it alone, so it lives in
../scripts/check-auth.js, which mints with this code and verifies with the
runner's. A green run here and a green run there still would not prove they
agree — only the crossing does.

The suite never reaches the network: accounts/testing.py stubs the Have I Been
Pwned client, and the settings-profile tests import the settings module in a
subprocess rather than calling anything.
"""
