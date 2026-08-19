// Load test (SC-002) against /validate. Reference request = 100 mixed elements.
// Usage: node packages/server/loadtest/run.mjs  (server must be running on $PORT or 8080)
// Requires autocannon:  npx autocannon ...  (installed on demand)
import autocannon from 'autocannon';

const url = `http://localhost:${process.env.PORT ?? 8080}/validate`;

const elements = Array.from({ length: 100 }, (_, i) => {
  if (i % 5 === 0) {
    return {
      tag: 'Icon',
      id: `i${i}`,
      x: i * 10,
      y: 0,
      name: 'lucide-server',
      size: 50,
    };
  }
  if (i % 7 === 0) {
    return {
      tag: 'Relationship',
      id: `r${i}`,
      x: 0,
      y: 0,
      from: `n${i - 1}`,
      to: `n${i - 2}`,
    };
  }
  return {
    tag: 'Shape',
    id: `n${i}`,
    x: i * 10,
    y: 40,
    texts: [{ text: `node ${i}` }],
  };
});

const result = await autocannon({
  url,
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(elements),
  connections: 50,
  duration: 20,
});

console.log(autocannon.printResult(result));
console.log(
  `p50=${result.latency.p50}ms p99=${result.latency.p99}ms rps=${result.requests.average}`,
);
// Provisional SLO: p99 < 50ms, p50 < 10ms @ ~200 rps on 1 vCPU / 512 MB.
process.exit(result.latency.p99 < 50 ? 0 : 1);
