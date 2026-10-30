// Broker-specific witness-journal persistence was deliberately removed during
// extraction. These compatibility seams perform no I/O and will disappear
// when the ActivityStreams adapters are simplified.
export function witnessJournalBindingFromArgv() { return null; }
export async function recordWitnessedBoundaryAct() { return undefined; }
export async function wasWitnessed() { return false; }
