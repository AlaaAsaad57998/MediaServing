const client = require("prom-client");

function counter(cfg) {
  return client.register.getSingleMetric(cfg.name) || new client.Counter(cfg);
}
function histogram(cfg) {
  return client.register.getSingleMetric(cfg.name) || new client.Histogram(cfg);
}

// Queue / background-job metrics, named per the company Application Metrics
// Standard (§6, §12) so the central "Application Metrics" Grafana dashboard
// picks them up automatically via the `queue_*` prefix.
const jobsProcessed = counter({
  name: "queue_jobs_processed_total",
  help: "Total background jobs processed successfully.",
});
const jobsFailed = counter({
  name: "queue_jobs_failed_total",
  help: "Total background jobs that failed.",
});
const jobDuration = histogram({
  name: "queue_job_duration_seconds",
  help: "Duration of background jobs in seconds.",
  buckets: [1, 2, 5, 10, 20, 40, 80, 160],
});

module.exports = { jobsProcessed, jobsFailed, jobDuration };
