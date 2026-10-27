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

function hostLocalUsage(a, dau, mau, registered, equivalents, days, terminalRecordsOpening) {
  const h = a.hostLocal;
  const n = 1 + a.nonprodFraction;
  const retry = 1 + h.retryTrafficShare;
  const connectedDeviceHours = dau * h.connectedDeviceHoursPerDauDay * days;
  const activeAttemptHours = dau * h.activeAttemptHoursPerDauDay * days;
  const activeViewerHours = dau * h.activeViewerHoursPerDauDay * days;
  const idleDeviceHours = Math.max(0, connectedDeviceHours - Math.min(connectedDeviceHours, activeAttemptHours));
  const terminalAttempts = activeAttemptHours * h.terminalAttemptsPerActiveAttemptHour;
  const renewals = activeAttemptHours * 3600 / h.attemptRenewalSeconds;
  const trustRefreshes = connectedDeviceHours * 3600 / h.trustRefreshSeconds;
  const idlePresenceRefreshes = idleDeviceHours * 3600 / h.workerPresenceSeconds;
  const directHostSessionHours = activeViewerHours * h.directHostSessionHoursPerActiveViewerHour * h.machineProtocolActiveShare;
  const directHostSessionRefreshes = directHostSessionHours * 3600 / h.directHostSessionRefreshSeconds;
  const directHostSessionHttpRequests = directHostSessionRefreshes * h.directHostSessionWorkerHttpRequestsPerRefresh;
  const directHostSessionDoRequests = directHostSessionRefreshes * h.directHostSessionDoRequestsPerRefresh;
  const grantRevalidationSessionHours = connectedDeviceHours * h.grantRevalidationSessionsPerConnectedDeviceHour;
  const grantRevalidationRefreshes = grantRevalidationSessionHours * 3600 / h.grantRevalidationRefreshSeconds;
  const grantRevalidationHttpRequests = grantRevalidationRefreshes * h.grantRevalidationWorkerHttpRequestsPerRefresh;
  const grantRevalidationDoRequests = grantRevalidationRefreshes * h.grantRevalidationDoRequestsPerRefresh;
  const socketFactor = 1 - h.fallbackConnectedHourShare;
  const liveStatusFrames = terminalAttempts * h.archivedJobsPerTerminalAttempt * h.ephemeralStatusFramesPerTerminalJob;
  const machineStatusFrames = liveStatusFrames * h.machineProtocolActiveShare;
  const fallbackStatusFrames = liveStatusFrames - machineStatusFrames;
  const liveStatusBytes = liveStatusFrames * h.ephemeralStatusBytesPerFrame;
  const centralLiveStatusCopies = fallbackStatusFrames;
  const hostSessionStatusCopies = machineStatusFrames * h.hostSessionCopiesPerLiveStatusFrame;
  const eventAppendBatches = machineStatusFrames / Math.max(h.eventAppendMeanFramesPerBatch, 0.01);
  const eventAppendHttpRequests = eventAppendBatches * h.eventAppendWorkerHttpRequestsPerBatch;
  const eventAppendDoRequests = eventAppendBatches * h.eventAppendDoRequestsPerBatch;
  const webSocketMessages = (trustRefreshes + renewals + idlePresenceRefreshes) * socketFactor + fallbackStatusFrames;
  const fallbackHttp = connectedDeviceHours * h.fallbackConnectedHourShare * h.fallbackHttpRequestsPerDeviceHour;
  const migration = a.architectures[1];
  const migrationHttp = equivalents * migration.http * h.migrationOverlapShare;
  const migrationDo = equivalents * migration.doRequests * h.migrationOverlapShare;
  const migrationReads = equivalents * migration.reads * h.migrationOverlapShare;
  const migrationWrites = equivalents * migration.writes * h.migrationOverlapShare;
  const migrationDuration = dau * a.mix.reduce((v, x) => v + x.share * x.hoursPerDay / 8, 0) * days * 8 * 3600 * migration.awake * h.migrationOverlapShare * a.doMemoryGb;
  const http = (dau * h.coreHttpRequestsPerDauDay * days + fallbackHttp + migrationHttp + eventAppendHttpRequests + directHostSessionHttpRequests + grantRevalidationHttpRequests) * retry * n;
  const doRequests = (dau * h.coreDoRequestsPerDauDay * days + webSocketMessages / h.webSocketMessagesPerBillableRequest + eventAppendDoRequests + directHostSessionDoRequests + grantRevalidationDoRequests + fallbackHttp * h.fallbackDoRequestsPerHttp + migrationDo) * retry * n;
  const doSeconds = dau * h.coreDoSecondsPerDauDay * days + webSocketMessages * h.webSocketHandlerSecondsPerMessage + eventAppendDoRequests * h.eventAppendDoSecondsPerRequest + directHostSessionDoRequests * h.directHostSessionDoSecondsPerRequest + grantRevalidationDoRequests * h.grantRevalidationDoSecondsPerRequest + migrationDuration / a.doMemoryGb;
  const archiveJobs = terminalAttempts * h.archivedJobsPerTerminalAttempt;
  const archiveSegments = archiveJobs * h.historyArchiveSegmentsPerJob;
  const archiveEventRows = archiveSegments * h.historyArchiveEventRowsPerSegment;
  const sealedInputs = archiveJobs * h.sealedInputShare;
  const activitySqliteReads = machineStatusFrames * h.eventAppendSqliteReadsPerEvent + eventAppendBatches * h.eventAppendSqliteFixedReadsPerBatch + fallbackStatusFrames * h.fallbackActivitySqliteReadsPerEvent;
  const activitySqliteWrites = machineStatusFrames * h.eventAppendSqliteWritesPerEvent + eventAppendBatches * h.eventAppendAggregateSqliteWritesPerBatch + fallbackStatusFrames * h.fallbackActivitySqliteWritesPerEvent;
  // A mature 90-day cohort has one expiry per new input archive each month.
  const sealedInputDeletes = sealedInputs;
  const directHostSessionSqliteReadsPerRefresh = h.directHostSessionSqliteFixedReadsPerRefresh + h.directHostSessionSqliteReadsPerRegisteredHost * h.registeredHostsPerMau;
  const sqliteReads = (dau * h.coreSqliteReadsPerDauDay * days + renewals * h.attemptRenewalSqliteReads + idlePresenceRefreshes * h.workerPresenceSqliteReads + directHostSessionRefreshes * directHostSessionSqliteReadsPerRefresh + grantRevalidationRefreshes * h.grantRevalidationSqliteReadsPerRefresh + terminalAttempts + archiveEventRows + activitySqliteReads + migrationReads) * retry * n;
  const archiveSqliteWrites = archiveSegments * (4 + 2 * h.historyArchiveEventRowsPerSegment);
  const sealedInputSqliteWrites = sealedInputs * h.sealedInputSqliteRowsPerCompaction + sealedInputDeletes * h.sealedInputSqliteRowsPerExpiry;
  const sqliteWrites = (dau * h.coreSqliteWritesPerDauDay * days + renewals * (h.attemptRenewalSqliteRows + h.attemptCounterRowsPerRenewal) + idlePresenceRefreshes * h.workerPresenceSqliteRows + terminalAttempts + archiveSqliteWrites + sealedInputSqliteWrites + activitySqliteWrites + migrationWrites) * retry * n;
  const terminalRecordsClosing = terminalRecordsOpening + terminalAttempts;
  const attemptReports = terminalAttempts * h.attemptReportShare;
  const sealedResults = terminalAttempts * h.sealedResultShare;
  const resultArtifacts = terminalAttempts * h.resultArtifactShare;
  const checkpoints = terminalAttempts * h.checkpointShare;
  const daysPerMonth = days;
  const historyGb = archiveJobs / daysPerMonth * h.historyArchiveBytesPerJob * h.historyArchiveRetentionDays / 1e9;
  const attemptReportGb = terminalAttempts / daysPerMonth * h.attemptReportShare * h.attemptReportBytes * h.attemptReportRetentionDays / 1e9;
  const sealedResultGb = terminalAttempts / daysPerMonth * h.sealedResultShare * h.sealedResultBytes * h.sealedResultRetentionDays / 1e9;
  const sealedInputGb = sealedInputs / daysPerMonth * h.sealedInputBytes * h.sealedInputRetentionDays / 1e9;
  const resultGb = terminalAttempts / daysPerMonth * h.resultArtifactShare * h.resultArtifactBytes * h.resultArtifactRetentionDays / 1e9;
  const checkpointGb = terminalAttempts / daysPerMonth * h.checkpointShare * h.checkpointBytes * h.checkpointRetentionDays / 1e9;
  const doGb = (registered * h.coordinatorBytesPerRetainedAccount + terminalRecordsClosing * h.terminalRecordBytes) / 1e9 * n + attemptReportGb * n;
  const r2Gb = (registered * h.syncSnapshotBytesPerRetainedAccount / 1e9 + historyGb + sealedResultGb + sealedInputGb + resultGb + checkpointGb + registered * h.migrationOverlapBytesPerRetainedAccount / 1e9 * h.migrationOverlapShare) * n;
  const d1Gb = registered * h.d1MetadataBytesPerRetainedAccount / 1e9 * n;
  const r2A = (dau * h.syncClassAWritesPerDauDay * days + archiveSegments + sealedResults + sealedInputs + resultArtifacts * 2 + checkpoints * 2) * retry * n;
  const r2B = (dau * h.syncClassBReadsPerDauDay * days + archiveJobs * h.historyArchiveReadsPerJob + sealedResults * h.sealedResultReadsPerObject + sealedInputs * (2 + h.sealedInputGetsPerObject) + resultArtifacts * h.resultArtifactReadsPerArtifact + checkpoints * h.checkpointReadsPerCheckpoint) * retry * n;
  const d1Reads = (dau * h.d1ReadsPerDauDay * days + trustRefreshes * h.d1RowsPerTrustRefresh) * retry * n;
  const d1Writes = dau * h.d1WritesPerDauDay * days * retry * n;
  const cpu = http * a.cpuMsPerHttp;
  const logEvents = (http + doRequests) * a.logSample * a.logEventsPerHttp;
  const logGb = logEvents * a.logBytesPerEvent / 1e9;
  return {
    usage: {
      http, cpu, doRequests, doDuration: doSeconds * a.doMemoryGb * retry * n,
      doReads: sqliteReads, doWrites: sqliteWrites, doGb, r2Gb, r2A, r2B,
      d1Reads, d1Writes, d1Gb, logEvents, logGb,
      logStoredGb: logGb * a.logRetentionDays / days,
      containerCpu: 0, containerMemory: 0, containerDisk: 0, containerEgress: 0,
    },
    connectedDeviceHours, activeAttemptHours, activeViewerHours, idleDeviceHours, directHostSessionHours, directHostSessionRefreshes, directHostSessionHttpRequests, directHostSessionDoRequests, directHostSessionSqliteReadsPerRefresh, grantRevalidationSessionHours, grantRevalidationRefreshes, grantRevalidationHttpRequests, grantRevalidationDoRequests, terminalAttempts, attemptReports,
    terminalRecordsOpening, terminalRecordsClosing, renewals, trustRefreshes,
    idlePresenceRefreshes, webSocketMessages, liveStatusFrames, machineStatusFrames, fallbackStatusFrames,
    liveStatusBytes, centralLiveStatusCopies, hostSessionStatusCopies, eventAppendBatches, eventAppendHttpRequests,
    eventAppendDoRequests, activitySqliteReads, activitySqliteWrites, fallbackHttp, migrationHttp,
    registeredHosts: mau * h.registeredHostsPerMau, archiveGb: historyGb, archiveJobs, archiveSegments, archiveEventRows, attemptReportGb,
    sealedResults, sealedResultGb, sealedInputs, sealedInputGb, sealedInputPuts: sealedInputs, sealedInputHeads: 2 * sealedInputs,
    sealedInputGets: sealedInputs * h.sealedInputGetsPerObject, sealedInputDeletes, resultArtifactGb: resultGb, checkpointGb,
  };
}

export function month(a, dau, registered, index = 0, days = 30, state = {}) {
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
  const hostLocal = a.architecture === 5
    ? hostLocalUsage(a, dau, mau, registered, equivalents, days, state.terminalRecordsOpening ?? registered * a.hostLocal.openingTerminalRecordsPerRetainedAccount)
    : undefined;
  const free = hostLocal?.usage ?? {
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
  if (!hostLocal) {
    free.logGb = free.logEvents * a.logBytesPerEvent / 1e9;
    free.logStoredGb = free.logGb * a.logRetentionDays / days;
  }
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
  const tunnelsUsd = a.architecture >= 4 ? mau * a.allocatedHostsPerMau * a.tunnelUsdPerHost : 0;
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
    ...(hostLocal ? { hostLocal: { ...hostLocal, terminalRecordsClosing: hostLocal.terminalRecordsClosing } } : {}),
  };
}

export function forecast(a = assumptions, growth = a.growth.base) {
  let registered = 0;
  let terminalRecords = 0;
  let credit = a.creditUsd;
  return growth.map((dau, i) => {
    const priorRegistered = registered;
    registered = Math.max(registered, dau / a.dauToMau * a.registeredPerMau);
    if (a.architecture === 5) terminalRecords += (registered - priorRegistered) * a.hostLocal.openingTerminalRecordsPerRetainedAccount;
    const start = new Date(Date.UTC(2026, 9 + i, i === 0 ? 4 : 1));
    const end = new Date(Date.UTC(2026, 10 + i, 1));
    const days = (end - start) / 86400000;
    const result = month(a, dau, registered, i, days, { terminalRecordsOpening: terminalRecords });
    if (a.architecture === 5) terminalRecords = result.hostLocal.terminalRecordsClosing;
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
  for (const architecture of [1, 2, 3, 4, 5]) {
    const a = { ...assumptions, architecture };
    tables[a.architectures[architecture - 1].name] = [100, 1000, 5000, 10000].map(n => {
      if (architecture !== 5) return month(a, n, n / a.dauToMau * a.registeredPerMau, 2);
      return forecast(a, Array(12).fill(n)).at(-1);
    });
  }
  const growth = Object.fromEntries(Object.entries(assumptions.growth).map(([k, v]) => [k, { rows: forecast(assumptions, v), totals: summarize(forecast(assumptions, v)) }]));
  const launched = structuredClone(assumptions);
  launched.agents.launchMonth = 7;
  const optionalLaunch = { rows: forecast(launched), totals: summarize(forecast(launched)) };
  const hostLocal = { ...assumptions, architecture: 5 };
  const flatCredits = Object.fromEntries([100, 1000, 5000, 10000].map(dau => {
    const rows = forecast(hostLocal, Array(12).fill(dau));
    return [dau, { modeledFinalMonthGrossUsd: rows.at(-1).cfTotal, totals: summarize(rows), creditUsedUsd: summarize(rows).creditUsed, creditExpiredUsd: summarize(rows).creditExpired }];
  }));
  const hostLocalGrowth = Object.fromEntries(Object.entries(assumptions.growth).map(([name, path]) => {
    const rows = forecast(hostLocal, path);
    return [name, { rows, totals: summarize(rows) }];
  }));
  const exhaustionDate = rows => {
    let balance = assumptions.creditUsd;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const eligibleSpend = row.cfTotal * row.eligibleDays / row.days;
      if (eligibleSpend >= balance && balance > 0) {
        const start = new Date(Date.UTC(2026, 9 + i, i === 0 ? 4 : 1));
        const day = new Date(start.getTime() + balance / (row.cfTotal / row.days) * 86400000);
        return day.toISOString().slice(0, 10);
      }
      balance -= Math.min(balance, eligibleSpend);
      if (row.creditExpired > 0) return '2027-09-18 (expiry with balance)';
    }
    return '2027-09-18 (expiry with balance)';
  };
  const hostLocalStress = Object.fromEntries([
    ['aggregate-8-device-hours-one-target', 8, 8, 8, 1, 1],
    ['24-device-hours-one-active-viewer', 24, 8, 8, 1, 1],
    ['24-device-hours-all-pairs', 24, 24, 24, 2, 2],
  ].map(([name, connectedHours, attemptHours, viewerHours, sessionsPerViewerHour, statusCopies]) => {
    const scenario = structuredClone(hostLocal);
    scenario.hostLocal.connectedDevicesPerDau = 3;
    scenario.hostLocal.connectedDeviceHoursPerDauDay = connectedHours;
    scenario.hostLocal.activeAttemptHoursPerDauDay = attemptHours;
    scenario.hostLocal.activeViewerHoursPerDauDay = viewerHours;
    scenario.hostLocal.directHostSessionHoursPerActiveViewerHour = sessionsPerViewerHour;
    scenario.hostLocal.hostSessionCopiesPerLiveStatusFrame = statusCopies;
    scenario.mix = [{ name: 'Heavy three-device account', share: 1, hoursPerDay: 8, devices: 3 }];
    return [name, Object.fromEntries([100, 1000, 5000, 10000].map(dau => {
      const rows = forecast(scenario, Array(12).fill(dau));
      const totals = summarize(rows);
      return [dau, {
        activeViewerHoursPerDauDay: viewerHours,
        directHostSessionsPerActiveViewerHour: sessionsPerViewerHour,
        hostStatusCopiesPerFrame: statusCopies,
        modeledFinalMonthGrossUsd: rows.at(-1).cfTotal,
        creditUsedUsd: totals.creditUsed,
        creditExpiredUsd: totals.creditExpired,
        creditOutcome: totals.creditExpired > 0 ? 'expiry with balance' : 'exhausted',
        exhaustionOrExpiry: exhaustionDate(rows),
      }];
    }))];
  }));
  console.log(JSON.stringify({ tables, growth, optionalLaunch, hostLocalFlatCredits: flatCredits, hostLocalGrowth, hostLocalStress }, null, 2));
}
