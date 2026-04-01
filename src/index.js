require("./config/env");
const { buildApp } = require("./app");

const PORT = process.env.PORT || 3000;

const app = buildApp();

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Server listening on ${address}`);
});
