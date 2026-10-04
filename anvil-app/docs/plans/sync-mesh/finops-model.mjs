import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const assumptions = JSON.parse(fs.readFileSync(new URL('./finops-assumptions.json', import.meta.url), 'utf8'));
const excess = (usage, included) => Math.max(0, usage - included);
const million = (usage, included, rate, round = false) => (round ? Math.ceil(excess(usage, included) / 1e6) : excess(usage, included) / 1e6) * rate;

export function invoice(u, r, modernLogs) {
  return {
    workersBase: r.workersBase,
    http: million(u.http, r.httpIncluded, r.httpPerMillion),
    cpu: million(u.cpu, r.cpuIncluded, r.cpuPerMillion),
    doRequests: million(u.doRequests, r.doReqIncluded, r.doReqPerMillion, true),
    doDuration: million(u.doDuration, r.doDurationIncluded, r.doDurationPerMillion, true),
    doReads: million(u.doReads, r.doReadsIncluded, r.doReadsPerMillion),
    doWrites: million(u.doWrites, r.doWritesIncluded, r.doWritesPerMillion),
    doStorage: excess(u.doGb, r.doGbIncluded) * r.doGbPrice,
    r2Storage: Math.ceil(excess(u.r2Gb, r.r2GbIncluded)) * r.r2GbPrice,
    r2A: million(u.r2A, r.r2AIncluded, r.r2APerMillion, true),
    r2B: million(u.r2B, r.r2BIncluded, r.r2BPerMillion, true),
    d1Reads: million(u.d1Reads, r.d1ReadsIncluded, r.d1ReadsPerMillion),
    d1Writes: million(u.d1Writes, r.d1WritesIncluded, r.d1WritesPerMillion),
    d1Storage: excess(u.d1Gb, r.d1GbIncluded) * r.d1GbPrice,
    logs: modernLogs ? excess(u.logGb, r.logGbIncluded) * r.logGbPrice + excess(u.logStoredGb, r.logStoredGbIncluded) * r.logStoredGbPrice : million(u.logEvents, r.oldLogEventsIncluded, r.oldLogsPerMillion),
    containerCpu: excess(u.containerCpu, r.containerCpuHoursIncluded) * r.containerCpuHour,
    containerMemory: excess(u.containerMemory, r.containerMemoryHoursIncluded) * r.containerMemoryHour,
    containerDisk: excess(u.containerDisk, r.containerDiskHoursIncluded) * r.containerDiskHour,
    containerEgress: excess(u.containerEgress, r.containerEgressGbIncluded) * r.containerEgressGbPrice,
  };
}

export function month(a, dau, registered, index = 0, days = 30) {
  const mau = dau / a.dauToMau;
  const p = a.architectures[a.architecture - 1];
  const network = a.mix.reduce((v, x) => v + x.share * x.hoursPerDay * x.devices / 24, 0);
  const duration = a.mix.reduce((v, x) => v + x.share * x.hoursPerDay / 8, 0);
  const equivalents = dau * network * days / 30;
  const n = 1 + a.nonprodFraction;
  const agent = a.agents;
  const buyers = agent.launchMonth > 0 && index + 1 >= agent.launchMonth ? mau * agent.conversion : 0;
  const hours = buyers * agent.hoursPerBuyer;
  const runtime = hours * (1 + agent.runtimeOverhead);
  const free = {
    http: equivalents * p.http * n,
    cpu: equivalents * p.http * n * a.cpuMsPerHttp,
    doRequests: equivalents * p.doRequests * n,
    doDuration: (dau * duration * days * 8 * 3600 * p.awake * n + a.sessionObjects * days * 86400 * a.sessionAwake) * a.doMemoryGb,
    doReads: equivalents * p.reads * n,
    doWrites: equivalents * p.writes * n,
    doGb: registered * a.doGbPerRegistered * n,
    r2Gb: registered * a.r2GbPerRegistered * n,
    r2A: equivalents * a.r2APerHeavy * n,
    r2B: equivalents * a.r2BPerHeavy * n,
    d1Reads: mau * a.d1ReadsPerMau * n,
    d1Writes: mau * a.d1WritesPerMau * n,
    d1Gb: registered * a.d1GbPerRegistered * n,
    logEvents: equivalents * p.http * n * a.logSample * a.logEventsPerHttp,
    containerCpu: 0, containerMemory: 0, containerDisk: 0, containerEgress: 0,
  };
  free.logGb = free.logEvents * a.logBytesPerEvent / 1e9;
  free.logStoredGb = free.logGb * a.logRetentionDays / days;
  const combined = {
    ...free,
    http: free.http + runtime * agent.requestsPerHour,
    cpu: free.cpu + runtime * agent.requestsPerHour * a.cpuMsPerHttp,
    doRequests: free.doRequests + runtime * agent.doRequestsPerHour,
    doDuration: free.doDuration + runtime * 3600 * a.doMemoryGb,
    doReads: free.doReads + runtime * agent.doReadsPerHour,
    doWrites: free.doWrites + runtime * agent.doWritesPerHour,
    logEvents: free.logEvents + runtime * agent.logsGbPerHour * 1e9 / a.logBytesPerEvent,
    logGb: free.logGb + runtime * agent.logsGbPerHour,
    logStoredGb: (free.logGb + runtime * agent.logsGbPerHour) * a.logRetentionDays / days,
    containerCpu: runtime * agent.vcpu * agent.cpuUtilization,
    containerMemory: runtime * agent.memoryGib,
    containerDisk: runtime * agent.diskGb,
    containerEgress: runtime * agent.egressGbPerHour,
  };
  const modern = index >= 2;
  const freeMeters = invoice(free, a.rates, modern);
  const totalMeters = invoice(combined, a.rates, modern);
  const sum = o => Object.values(o).reduce((x, y) => x + y, 0);
  const cfFree = sum(freeMeters) + a.otherCloudflareUsd;
  const cfTotal = sum(totalMeters) + a.otherCloudflareUsd;
  const sharedUsd = a.websiteUsd + a.otherToolsUsd + mau * a.websiteReserveUsdPerMau + a.workosCustomDomainUsd + a.workosSsoConnections * 125;
  const tunnelsUsd = a.architecture === 4 ? mau * a.allocatedHostsPerMau * a.tunnelUsdPerHost : 0;
  const freeExternal = (cfFree + sharedUsd + tunnelsUsd) * a.gbpPerUsd;
  const cloudInfra = (cfTotal - cfFree) * a.gbpPerUsd;
  const revenue = hours * agent.priceGbpPerHour;
  // Economic allocation per pound consumed, not a cash top-up roll-forward.
  const payments = revenue * (agent.paymentPercentage + agent.paymentFixedGbp / agent.paymentBatchGbp + agent.billingPercentage);
  const refunds = revenue * agent.refundReserve;
  const paidSupport = buyers * agent.supportGbpPerBuyer;
  const contribution = revenue - cloudInfra - payments - refunds - paidSupport;
  const fixedLabor = (a.opsHours + a.incidentHours) * a.engineeringGbpPerHour;
  const supportLabor = mau * a.supportContactsPerMau * a.supportMinutes / 60 * a.supportGbpPerHour;
  const oneTimeLabor = index === 0 ? a.instrumentationHours * a.engineeringGbpPerHour : 0;
  const allIn = freeExternal + fixedLabor + supportLabor + oneTimeLabor;
  return { dau, mau, registered, days, equivalents, free, combined, freeMeters, totalMeters, cfFree, cfTotal, sharedUsd, tunnelsUsd, freeExternal, buyers, hours, runtime, cloudInfra, revenue, payments, refunds, paidSupport, contribution, fixedLabor, supportLabor, oneTimeLabor, allIn,
    cashReserve: freeExternal * (1 + a.contingency) + (fixedLabor + supportLabor + oneTimeLabor) * a.paidLaborFraction,
    allInNet: allIn - contribution,
    peakContainers: runtime / (days * 24) * agent.peakFactor,
  };
}

export function forecast(a = assumptions, growth = a.growth.base) {
  let registered = 0;
  let credit = a.creditUsd;
  return growth.map((dau, i) => {
    registered = Math.max(registered, dau / a.dauToMau * a.registeredPerMau);
    const start = new Date(Date.UTC(2026, 9 + i, i === 0 ? 4 : 1));
    const end = new Date(Date.UTC(2026, 10 + i, 1));
    const days = (end - start) / 86400000;
    const result = month(a, dau, registered, i, days);
    const eligibleDays = Math.max(0, Math.min(days, (new Date(a.creditExpires) - start) / 86400000));
    // Planning convention: prorate final-period eligible spend by days.
    // Actual invoice treatment at grant expiry requires provider confirmation.
    const used = Math.min(credit, result.cfTotal * eligibleDays / days);
    credit -= used;
    const expired = new Date(a.creditExpires) < end ? credit : 0;
    if (new Date(a.creditExpires) < end) credit = 0;
    return { ...result, eligibleDays, creditUsed: used, creditExpired: expired, creditRemaining: credit, cfCashAfterCredit: Math.max(0, result.cfTotal - used), externalCashAfterCredit: (Math.max(0, result.cfTotal - used) + result.sharedUsd + result.tunnelsUsd) * a.gbpPerUsd };
  });
}

export function summarize(rows) {
  const keys = ['freeExternal', 'cashReserve', 'revenue', 'cloudInfra', 'contribution', 'fixedLabor', 'supportLabor', 'oneTimeLabor', 'allIn', 'allInNet', 'creditUsed', 'creditExpired', 'cfCashAfterCredit', 'externalCashAfterCredit'];
  return Object.fromEntries(keys.map(k => [k, rows.reduce((s, x) => s + x[k], 0)]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tables = {};
  for (const architecture of [1, 2, 3, 4]) {
    const a = { ...assumptions, architecture };
    tables[a.architectures[architecture - 1].name] = [100, 1000, 10000].map(n => month(a, n, n / a.dauToMau * a.registeredPerMau, 2));
  }
  const growth = Object.fromEntries(Object.entries(assumptions.growth).map(([k, v]) => [k, { rows: forecast(assumptions, v), totals: summarize(forecast(assumptions, v)) }]));
  const launched = structuredClone(assumptions);
  launched.agents.launchMonth = 7;
  const optionalLaunch = { rows: forecast(launched), totals: summarize(forecast(launched)) };
  console.log(JSON.stringify({ tables, growth, optionalLaunch }, null, 2));
}
