const client = require("prom-client");

function counter(cfg) {
  return client.register.getSingleMetric(cfg.name) || new client.Counter(cfg);
}
function histogram(cfg) {
  return client.register.getSingleMetric(cfg.name) || new client.Histogram(cfg);
}

const jobsTotal = counter({
  name: "video_jobs_total",
  help: "Polished video jobs by result",
  labelNames: ["result"],
});
const jobDuration = histogram({
  name: "video_job_duration_seconds",
  help: "Duration of polished video jobs",
  buckets: [1, 2, 5, 10, 20, 40, 80, 160],
});
const fallbackServed = counter({
  name: "video_fallback_served_total",
  help: "Fallback (pending) video responses served",
  labelNames: ["kind"], // instant | original
});

module.exports = { jobsTotal, jobDuration, fallbackServed };
