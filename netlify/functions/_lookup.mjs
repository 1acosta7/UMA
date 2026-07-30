// Hand-coded, small numeric cross-check lookup -- deliberately NOT a rules
// engine. This does not decide anything and is never used to generate the
// agent-facing answer; it only checks whether the extracted client value the
// final model cited is *plausible* against a real, source-grounded number,
// and flags a mismatch for human review. Every number below was transcribed
// directly from the actual carrier guideline PDFs in the local Underwriting
// Library on 2026-07-29 -- nothing here is invented. Where a carrier's
// currently-ingested documents don't state a numeric threshold for a field
// (e.g. no carrier here uses a numeric A1C cutoff -- all four gate diabetes
// via age/duration/insulin-flag/build instead), that field is marked
// unavailable rather than filled with a guessed number, and the cross-check
// silently skips it -- no lookup data means no flag, never a fabricated one.

// --- build/BMI charts -------------------------------------------------

// Transamerica FE Express Solution -- Adult Build Chart, p.14 (PDF page
// index, "Transamerica - FE Express Solution Agent and Underwriting Guide.pdf").
// BMI-based, not height/weight-based.
const TRANSAMERICA_FEX_BMI_BANDS = [
  { min: 15.000, max: 18.499, class: "Graded" },
  { min: 18.500, max: 46.000, class: "Select" },
  { min: 46.001, max: 48.000, class: "Graded" },
  // Below 15.000 or above 48.000: "no coverage will be available" per the
  // chart's own footnote.
];

// Allianz M-3405 -- Unisex build chart, p.3 ("Allianz - Underwriting
// Guidelines (M-3405).pdf"). Height/weight-based. Each row: a universal
// minimum weight (underweight boundary, same across classes at that height),
// then a maximum qualifying weight per rate class -- exceeding a class's max
// drops to the next-lower class, exceeding Standard is individual
// consideration / decline territory. Class order confirmed by the numbers
// increasing together (Preferred Plus NT is always the tightest).
const ALLIANZ_BUILD_CHART = [
  { heightIn: 56, minWeight: 79, preferredPlusNontobaccoMax: 125, preferredNontobaccoMax: 140, standardNontobaccoMax: 178, preferredTobaccoMax: 135, standardTobaccoMax: 178 },
  { heightIn: 57, minWeight: 81, preferredPlusNontobaccoMax: 131, preferredNontobaccoMax: 145, standardNontobaccoMax: 184, preferredTobaccoMax: 140, standardTobaccoMax: 184 },
  { heightIn: 58, minWeight: 84, preferredPlusNontobaccoMax: 136, preferredNontobaccoMax: 151, standardNontobaccoMax: 191, preferredTobaccoMax: 145, standardTobaccoMax: 191 },
  { heightIn: 59, minWeight: 87, preferredPlusNontobaccoMax: 141, preferredNontobaccoMax: 157, standardNontobaccoMax: 198, preferredTobaccoMax: 150, standardTobaccoMax: 198 },
  { heightIn: 60, minWeight: 90, preferredPlusNontobaccoMax: 146, preferredNontobaccoMax: 163, standardNontobaccoMax: 204, preferredTobaccoMax: 156, standardTobaccoMax: 204 },
  { heightIn: 61, minWeight: 93, preferredPlusNontobaccoMax: 151, preferredNontobaccoMax: 169, standardNontobaccoMax: 211, preferredTobaccoMax: 164, standardTobaccoMax: 211 },
  { heightIn: 62, minWeight: 96, preferredPlusNontobaccoMax: 157, preferredNontobaccoMax: 175, standardNontobaccoMax: 218, preferredTobaccoMax: 167, standardTobaccoMax: 218 },
  { heightIn: 63, minWeight: 99, preferredPlusNontobaccoMax: 162, preferredNontobaccoMax: 181, standardNontobaccoMax: 225, preferredTobaccoMax: 172, standardTobaccoMax: 225 },
  { heightIn: 64, minWeight: 102, preferredPlusNontobaccoMax: 167, preferredNontobaccoMax: 187, standardNontobaccoMax: 233, preferredTobaccoMax: 177, standardTobaccoMax: 233 },
  { heightIn: 65, minWeight: 106, preferredPlusNontobaccoMax: 172, preferredNontobaccoMax: 193, standardNontobaccoMax: 240, preferredTobaccoMax: 182, standardTobaccoMax: 240 },
  { heightIn: 66, minWeight: 109, preferredPlusNontobaccoMax: 177, preferredNontobaccoMax: 199, standardNontobaccoMax: 247, preferredTobaccoMax: 187, standardTobaccoMax: 247 },
  { heightIn: 67, minWeight: 112, preferredPlusNontobaccoMax: 182, preferredNontobaccoMax: 205, standardNontobaccoMax: 255, preferredTobaccoMax: 192, standardTobaccoMax: 255 },
  { heightIn: 68, minWeight: 116, preferredPlusNontobaccoMax: 186, preferredNontobaccoMax: 211, standardNontobaccoMax: 263, preferredTobaccoMax: 196, standardTobaccoMax: 263 },
  { heightIn: 69, minWeight: 119, preferredPlusNontobaccoMax: 192, preferredNontobaccoMax: 217, standardNontobaccoMax: 270, preferredTobaccoMax: 202, standardTobaccoMax: 270 },
  { heightIn: 70, minWeight: 122, preferredPlusNontobaccoMax: 196, preferredNontobaccoMax: 223, standardNontobaccoMax: 278, preferredTobaccoMax: 206, standardTobaccoMax: 278 },
  { heightIn: 71, minWeight: 126, preferredPlusNontobaccoMax: 202, preferredNontobaccoMax: 229, standardNontobaccoMax: 286, preferredTobaccoMax: 212, standardTobaccoMax: 286 },
  { heightIn: 72, minWeight: 130, preferredPlusNontobaccoMax: 207, preferredNontobaccoMax: 235, standardNontobaccoMax: 294, preferredTobaccoMax: 217, standardTobaccoMax: 294 },
  { heightIn: 73, minWeight: 133, preferredPlusNontobaccoMax: 212, preferredNontobaccoMax: 241, standardNontobaccoMax: 303, preferredTobaccoMax: 222, standardTobaccoMax: 303 },
  { heightIn: 74, minWeight: 137, preferredPlusNontobaccoMax: 217, preferredNontobaccoMax: 247, standardNontobaccoMax: 311, preferredTobaccoMax: 227, standardTobaccoMax: 311 },
  { heightIn: 75, minWeight: 141, preferredPlusNontobaccoMax: 222, preferredNontobaccoMax: 253, standardNontobaccoMax: 320, preferredTobaccoMax: 232, standardTobaccoMax: 320 },
  { heightIn: 76, minWeight: 144, preferredPlusNontobaccoMax: 228, preferredNontobaccoMax: 259, standardNontobaccoMax: 328, preferredTobaccoMax: 238, standardTobaccoMax: 328 },
  { heightIn: 77, minWeight: 148, preferredPlusNontobaccoMax: 233, preferredNontobaccoMax: 265, standardNontobaccoMax: 337, preferredTobaccoMax: 243, standardTobaccoMax: 337 },
  { heightIn: 78, minWeight: 152, preferredPlusNontobaccoMax: 238, preferredNontobaccoMax: 271, standardNontobaccoMax: 346, preferredTobaccoMax: 248, standardTobaccoMax: 346 },
  { heightIn: 79, minWeight: 156, preferredPlusNontobaccoMax: 244, preferredNontobaccoMax: 277, standardNontobaccoMax: 355, preferredTobaccoMax: 254, standardTobaccoMax: 355 },
  { heightIn: 80, minWeight: 160, preferredPlusNontobaccoMax: 250, preferredNontobaccoMax: 283, standardNontobaccoMax: 364, preferredTobaccoMax: 260, standardTobaccoMax: 364 },
];

// Foresters -- Adult Build Chart (16+), Fully Underwritten, PDF p.10
// ("Foresters - Underwriting Guide ... Apr2026.pdf"). Height/weight-based,
// maximum qualifying weight per class. NOTE: the separate Non-Medical build
// chart (p.11) and the Diabetes-specific duration+build combined chart
// ("Diabetes Ratings for Non-Med Business") are NOT encoded here -- kept to
// the one general chart to stay "lightweight, not a rules engine"; extend
// this if the new architecture needs those too. Table was also only
// transcribed through 6'7" (extraction window cut off there) -- extend for
// taller heights before relying on this for a client above 6'7".
const FORESTERS_BUILD_CHART = [
  { heightIn: 56, preferredPlusOrSmokerMax: 118, preferredMax: 125, standardPlusMax: 143, standardMax: 162 },
  { heightIn: 57, preferredPlusOrSmokerMax: 122, preferredMax: 130, standardPlusMax: 150, standardMax: 168 },
  { heightIn: 58, preferredPlusOrSmokerMax: 126, preferredMax: 135, standardPlusMax: 155, standardMax: 174 },
  { heightIn: 59, preferredPlusOrSmokerMax: 130, preferredMax: 137, standardPlusMax: 160, standardMax: 180 },
  { heightIn: 60, preferredPlusOrSmokerMax: 144, preferredMax: 152, standardPlusMax: 167, standardMax: 186 },
  { heightIn: 61, preferredPlusOrSmokerMax: 149, preferredMax: 158, standardPlusMax: 175, standardMax: 193 },
  { heightIn: 62, preferredPlusOrSmokerMax: 152, preferredMax: 162, standardPlusMax: 180, standardMax: 199 },
  { heightIn: 63, preferredPlusOrSmokerMax: 157, preferredMax: 166, standardPlusMax: 185, standardMax: 206 },
  { heightIn: 64, preferredPlusOrSmokerMax: 161, preferredMax: 172, standardPlusMax: 190, standardMax: 211 },
  { heightIn: 65, preferredPlusOrSmokerMax: 166, preferredMax: 178, standardPlusMax: 195, standardMax: 219 },
  { heightIn: 66, preferredPlusOrSmokerMax: 170, preferredMax: 182, standardPlusMax: 200, standardMax: 226 },
  { heightIn: 67, preferredPlusOrSmokerMax: 176, preferredMax: 190, standardPlusMax: 205, standardMax: 233 },
  { heightIn: 68, preferredPlusOrSmokerMax: 180, preferredMax: 195, standardPlusMax: 210, standardMax: 240 },
  { heightIn: 69, preferredPlusOrSmokerMax: 184, preferredMax: 200, standardPlusMax: 215, standardMax: 247 },
  { heightIn: 70, preferredPlusOrSmokerMax: 190, preferredMax: 205, standardPlusMax: 222, standardMax: 254 },
  { heightIn: 71, preferredPlusOrSmokerMax: 196, preferredMax: 210, standardPlusMax: 227, standardMax: 261 },
  { heightIn: 72, preferredPlusOrSmokerMax: 202, preferredMax: 220, standardPlusMax: 234, standardMax: 269 },
  { heightIn: 73, preferredPlusOrSmokerMax: 206, preferredMax: 225, standardPlusMax: 242, standardMax: 276 },
  { heightIn: 74, preferredPlusOrSmokerMax: 211, preferredMax: 230, standardPlusMax: 247, standardMax: 284 },
  { heightIn: 75, preferredPlusOrSmokerMax: 216, preferredMax: 240, standardPlusMax: 252, standardMax: 292 },
  { heightIn: 76, preferredPlusOrSmokerMax: 221, preferredMax: 244, standardPlusMax: 258, standardMax: 299 },
  { heightIn: 77, preferredPlusOrSmokerMax: 227, preferredMax: 251, standardPlusMax: 264, standardMax: 307 },
  { heightIn: 78, preferredPlusOrSmokerMax: 244, preferredMax: 260, standardPlusMax: 270, standardMax: 315 },
  { heightIn: 79, preferredPlusOrSmokerMax: 249, preferredMax: 265, standardPlusMax: 276, standardMax: null }, // extraction cut off
];

export const NUMERIC_LOOKUP = {
  transamerica: {
    build: { available: true, kind: "bmi_bands", sourceDocId: "transamerica_fe_express", sourcePage: 14, data: TRANSAMERICA_FEX_BMI_BANDS },
    a1c: { available: false, note: "FE Express's single-condition chart gates diabetes purely on insulin-use (flag), no numeric A1C cutoff appears anywhere in the ingested document." },
    psa: { available: false, note: "No PSA/prostate numeric threshold found in the ingested Transamerica documents." },
  },
  allianz: {
    build: { available: true, kind: "height_weight_table", sourceDocId: "allianz_uw_guide", sourcePage: 3, data: ALLIANZ_BUILD_CHART },
    a1c: { available: false, note: "M-3405's Preferred-tier eligibility table gates diabetes as a binary 'no history of diabetes' exclusion for Preferred classes, no numeric A1C cutoff appears in the ingested document." },
    psa: { available: false, note: "No PSA/prostate numeric threshold found in the ingested Allianz documents." },
  },
  foresters: {
    build: { available: true, kind: "height_weight_table", sourceDocId: "foresters_main_uw_apr26", sourcePage: 10, data: FORESTERS_BUILD_CHART },
    a1c: { available: false, note: "Foresters' Diabetes Ratings for Non-Med Business gates diabetes on duration-since-diagnosis + build, not a numeric A1C cutoff -- no A1C number appears in any ingested Foresters document." },
    psa: { available: false, note: "No PSA/prostate numeric threshold found in the ingested Foresters documents." },
  },
  fg: {
    // Confirmed real gap, not an oversight: the user's own MASTER INDEX.txt
    // for the local underwriting library flags this same gap ("Build chart /
    // height-weight table: not found on Saleslink portal"), and no build
    // chart exists in any F&G document currently ingested.
    build: { available: false, note: "No build/BMI chart exists in any currently-ingested F&G document -- a genuine source-data gap, not an omission from this lookup." },
    a1c: { available: false, note: "F&G's diabetes rating (ADV5544) is banded by age + duration, qualitative 'well controlled' -- no numeric A1C cutoff appears in the ingested document." },
    psa: { available: false, note: "No PSA/prostate numeric threshold found in the ingested F&G documents." },
  },
};

function feetInchesToTotalInches(feet, inches) {
  return feet * 12 + inches;
}

function bmiFromHeightWeight(heightIn, weightLbs) {
  return (weightLbs / (heightIn * heightIn)) * 703;
}

// Looks up the nearest exact-height row (charts are per-inch, so this is an
// exact match, not interpolation) and returns the qualifying rate class for
// a given weight, plus the raw row for display. Returns null if the height
// isn't covered by the table (out of the transcribed range).
function classifyHeightWeight(table, heightIn, weightLbs, classFields) {
  const row = table.find((r) => r.heightIn === heightIn);
  if (!row) return null;
  for (const { field, label } of classFields) {
    const max = row[field];
    if (max != null && weightLbs <= max) return { class: label, row };
  }
  return { class: "above table range (individual consideration / decline territory)", row };
}

function classifyBMI(bands, bmi) {
  for (const band of bands) {
    if (bmi >= band.min && bmi <= band.max) return band.class;
  }
  return "outside charted range (no coverage per chart footnote)";
}

// The actual cross-check: given a carrier id, the client's stated
// height/weight, and the rate class the final model's answer claimed, checks
// whether the lookup table agrees. Never used to pick or override an
// answer -- only to flag disagreement for human review. Returns
// {checked: false, reason} when there's no lookup data to check against
// (never a false flag), or {checked: true, agrees, lookupClass, detail}.
export function crossCheckBuild({ carrier, heightIn, weightLbs, statedClass }) {
  const entry = NUMERIC_LOOKUP[carrier]?.build;
  if (!entry?.available) {
    // A genuine carrier-side gap (no build chart exists for this carrier in
    // the ingested documents) -- distinct from the client simply not having
    // given height/weight, which is a client-data gap, not a carrier one.
    // Only the former belongs in the agent-facing dataGaps note.
    return { checked: false, reasonType: "no_carrier_data", reason: entry?.note || "No build lookup data for this carrier." };
  }
  if (heightIn == null || weightLbs == null) {
    return { checked: false, reasonType: "no_client_data", reason: "Client height/weight not both available to check." };
  }

  if (entry.kind === "bmi_bands") {
    const bmi = bmiFromHeightWeight(heightIn, weightLbs);
    const lookupClass = classifyBMI(entry.data, bmi);
    const agrees = statedClass ? String(statedClass).toLowerCase().includes(lookupClass.toLowerCase().split(" ")[0]) : null;
    return {
      checked: true, agrees, lookupClass, computedBMI: Math.round(bmi * 10) / 10,
      sourceDocId: entry.sourceDocId, sourcePage: entry.sourcePage,
      detail: `Computed BMI ${Math.round(bmi * 10) / 10} -> ${lookupClass} per FE Express Adult Build Chart, p.${entry.sourcePage}.`,
    };
  }

  if (entry.kind === "height_weight_table") {
    const classFields = carrier === "allianz"
      ? [
          { field: "preferredPlusNontobaccoMax", label: "Preferred Plus Nontobacco" },
          { field: "preferredNontobaccoMax", label: "Preferred Nontobacco" },
          { field: "standardNontobaccoMax", label: "Standard Nontobacco" },
        ]
      : [
          { field: "preferredPlusOrSmokerMax", label: "Preferred Plus / Preferred Smoker" },
          { field: "preferredMax", label: "Preferred" },
          { field: "standardPlusMax", label: "Standard Plus" },
          { field: "standardMax", label: "Standard" },
        ];
    const result = classifyHeightWeight(entry.data, heightIn, weightLbs, classFields);
    if (!result) {
      return { checked: false, reasonType: "no_carrier_data", reason: `Height ${heightIn}in not covered by the transcribed table range for this carrier.` };
    }
    const agrees = statedClass ? String(statedClass).toLowerCase().includes(result.class.toLowerCase().split(" ")[0].split("/")[0]) : null;
    return {
      checked: true, agrees, lookupClass: result.class,
      sourceDocId: entry.sourceDocId, sourcePage: entry.sourcePage,
      detail: `${weightLbs}lbs at ${heightIn}in -> ${result.class} per build chart, p.${entry.sourcePage}.`,
    };
  }

  return { checked: false, reasonType: "no_carrier_data", reason: "Unrecognized lookup kind." };
}

// Structurally unavailable for all four carriers, independent of whether the
// client even provided an A1C/PSA value -- always a carrier-side gap, so
// always reasonType "no_carrier_data" here.
export function crossCheckA1C({ carrier, a1c, statedOutcome }) {
  const entry = NUMERIC_LOOKUP[carrier]?.a1c;
  return { checked: false, reasonType: "no_carrier_data", reason: entry?.note || "No A1C lookup data for this carrier -- none of the four carriers currently use a numeric A1C cutoff in their ingested documents." };
}

export function crossCheckPSA({ carrier, psa, statedOutcome }) {
  const entry = NUMERIC_LOOKUP[carrier]?.psa;
  return { checked: false, reasonType: "no_carrier_data", reason: entry?.note || "No PSA lookup data for this carrier." };
}

export { feetInchesToTotalInches, bmiFromHeightWeight };
