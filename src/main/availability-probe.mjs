import { availabilitySignatureOf } from "../protocols/music.mjs";

const BUFFER_LIMIT = 5000;
const DEFAULT_VERIFY_LIMIT = 3;
const DEFAULT_SNAPSHOT_EVERY = 500;

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function verificationLabel(value) {
  if (value === "ok") return "ok";
  if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)) return value;
  return "失败";
}

export function createAvailabilityProbe({
  knownOffline = new Set(),
  log = () => undefined,
  verify = null,
  verifyLimit = DEFAULT_VERIFY_LIMIT,
  snapshotEvery = DEFAULT_SNAPSHOT_EVERY,
} = {}) {
  const offlineIds = knownOffline instanceof Set ? knownOffline : new Set(knownOffline);
  const limit = positiveInt(verifyLimit, DEFAULT_VERIFY_LIMIT);
  const snapshotInterval = positiveInt(snapshotEvery, DEFAULT_SNAPSHOT_EVERY);
  const seenSignatures = new Set();
  const signatureCounts = new Map();
  const suspiciousSignatures = new Set();
  const buffer = [];
  const checkedIds = new Set();
  let suspiciousChecks = 0;
  let entryCount = 0;
  let controlSnapshotTaken = false;

  const write = (line) => {
    try {
      log(line);
    } catch {
      // 诊断日志失败不应影响列表归一化。
    }
  };

  const candidatesOf = (signature) => {
    const candidates = [];
    const candidateIds = new Set();
    for (const entry of buffer) {
      if (entry.signature !== signature || offlineIds.has(entry.id) || checkedIds.has(entry.id) || candidateIds.has(entry.id)) continue;
      candidateIds.add(entry.id);
      candidates.push(entry.id);
      if (candidates.length >= limit) break;
    }
    return candidates;
  };

  const verifyOne = (id, kind) => {
    if (typeof verify !== "function" || checkedIds.has(id)) return;
    checkedIds.add(id);
    if (kind === "suspicious") suspiciousChecks += 1;
    const finish = (result) => write(`可用性取证：校验 ${kind === "suspicious" ? "可疑" : "对照"} ${id} → ${verificationLabel(result)}`);
    const fail = () => write(`可用性取证：校验 ${kind === "suspicious" ? "可疑" : "对照"} ${id} → 失败`);
    Promise.resolve()
      .then(() => verify(id))
      .then(finish, fail);
  };

  const verifySuspiciousCandidates = (signature) => {
    if (typeof verify !== "function" || suspiciousChecks >= limit) return;
    for (const id of candidatesOf(signature)) {
      if (suspiciousChecks >= limit) break;
      verifyOne(id, "suspicious");
    }
  };

  const verifyControlCandidates = (signature) => {
    if (typeof verify !== "function") return;
    for (const id of candidatesOf(signature)) verifyOne(id, "control");
  };

  const snapshot = () => {
    const distribution = [...signatureCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([signature, count]) => `${signature}=${count}`)
      .join(", ");
    write(`可用性取证：分布 ${distribution}`);

    if (controlSnapshotTaken) return;
    controlSnapshotTaken = true;
    const control = [...signatureCounts.entries()]
      .filter(([signature]) => !suspiciousSignatures.has(signature))
      .sort((left, right) => right[1] - left[1])[0];
    if (control !== undefined) verifyControlCandidates(control[0]);
  };

  return (id, raw) => {
    const trackId = String(id);
    const signature = availabilitySignatureOf(raw);
    if (!seenSignatures.has(signature)) {
      seenSignatures.add(signature);
      write(`可用性取证：新签名 ${signature}`);
    }

    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
    buffer.push({ id: trackId, signature });
    if (buffer.length > BUFFER_LIMIT) buffer.shift();

    if (offlineIds.has(trackId)) {
      write(`可用性取证：已知下架 ${trackId} ${signature}`);
      suspiciousSignatures.add(signature);
    }
    if (suspiciousSignatures.has(signature)) verifySuspiciousCandidates(signature);

    entryCount += 1;
    if (entryCount % snapshotInterval === 0) snapshot();
  };
}
