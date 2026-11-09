window.SwaggerUIBundle({
  url: '/openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  filter: true,
  displayRequestDuration: true,
  docExpansion: 'list',
  defaultModelsExpandDepth: 0,
  withCredentials: true,
  persistAuthorization: false,
  validatorUrl: null,
  presets: [window.SwaggerUIBundle.presets.apis],
});
