describe('Contact', () => {
  beforeEach(() => {
    cy.visit('/demo.html');
  });

  it('shows the sign-in form', () => {
    cy.contains('Sign in to your account').should('be.visible');
    cy.get('#em').type('qa@example.com');
    cy.get('.spinner').should('not.exist');
  });
});
