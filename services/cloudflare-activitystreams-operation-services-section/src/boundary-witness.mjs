/**
 * Boundary acts witnessed in a semantic record journal: each accepted,
 * refused or completed ActivityStreams act of an operation adapter is one
 * record under the resource-brokerage boundary-act category, and an adapter
 * asks the journal whether an act already reached an outcome before redoing it.
 * The journal is bound by `--witness-journal-data-root <dir>`; without one no
 * act is recorded and none counts as witnessed.
 */
import { createSemanticRecordJournal } from "@red-cup-engineering/semiotic-eavt-services-section/record-semantic-record";

export const BOUNDARY_ACT_CATEGORY = "resource-brokerage.boundary-act";
const OBJECT_KIND = "resource-brokerage.boundary-act";

/** The journal named on the command line, or null when none is bound. */
export function witnessJournalBindingFromArgv(argv = process.argv) {
  const index = argv.indexOf("--witness-journal-data-root");
  return index === -1 || !argv[index + 1] ? null : createWitnessJournalDataRootBinding(argv[index + 1]);
}

/** A boundary-act journal over one data root. */
export function createWitnessJournalDataRootBinding(root) {
  return createSemanticRecordJournal({ root, objectKind: OBJECT_KIND });
}

/** Record one act and its outcome under a contract; refusals carry refutation. */
export async function recordWitnessedBoundaryAct(activity, outcome, at, contract, details = {}, binding) {
  if (!binding) return undefined;
  const refused = /refus|reject/u.test(outcome);
  return binding.record({
    category: BOUNDARY_ACT_CATEGORY,
    recordedAt: at,
    record: { activity: activity?.id ?? null, type: activity?.type ?? null, actor: activity?.actor ?? null, outcome, contract, details },
    told: { for: !refused, against: refused },
  });
}

/** Whether a subject act already reached this outcome in the bound journal. */
export async function wasWitnessed(subject, outcome, _at, binding) {
  if (!binding) return false;
  return binding.query({ category: BOUNDARY_ACT_CATEGORY }).some(({ record }) => record.activity === (subject?.id ?? subject) && record.outcome === outcome);
}

/** Every witnessed boundary act in the bound journal. */
export function witnessedBoundaryActs(binding) {
  return binding ? binding.query({ category: BOUNDARY_ACT_CATEGORY }).map(({ record }) => record) : [];
}
