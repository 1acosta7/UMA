// Hand-coded, small numeric cross-check lookup -- deliberately NOT a rules
// engine. This does not decide anything and is never used to generate the
// agent-facing answer; it only checks whether the extracted client value the
// final model cited is *plausible* against a real, source-grounded number,
// and flags a mismatch for human review. Every number below was transcribed
// directly from the actual carrier guideline PDFs in the local Underwriting
// Library -- nothing here is invented. Where a carrier/product combination's
// currently-ingested documents don't state a numeric threshold, that field
// is marked unavailable rather than filled with a guessed number, and the
// cross-check silently skips it -- no lookup data means no flag, never a
// fabricated one.
//
// 2026-08-01 update: the full Phase 1 knowledge-base read of all 26 source
// PDFs found that several carriers have MULTIPLE distinct build/BMI charts
// and A1C scopes depending on the specific product, not one chart per
// carrier as originally coded. Build lookups are now variant-aware: each
// carrier's `build.variants` array lists every known chart, each matched
// case-insensitively against the recommended product's free-text name via
// `matchKeywords`, with an optional `isDefault` used only when no product
// text is available or nothing matches. A carrier with no matching variant
// and no default returns unavailable rather than guessing which chart
// applies -- silently reusing the wrong chart for the wrong product would be
// worse than not checking at all.

// --- Transamerica build/BMI charts --------------------------------------

// FE Express Solution / Graded FE Express Solution -- Adult Build Chart,
// p.14 ("Transamerica - FE Express Solution Agent and Underwriting
// Guide.pdf"). BMI-based, not height/weight-based, single Graded/Select
// outcome (no further rate-class tiers).
const TRANSAMERICA_FEX_BMI_BANDS = [
  { min: 15.000, max: 18.499, class: "Graded" },
  { min: 18.500, max: 46.000, class: "Select" },
  { min: 46.001, max: 48.000, class: "Graded" },
  // Below 15.000 or above 48.000: "no coverage will be available" per the
  // chart's own footnote.
];

// Transamerica Lifetime / FCIUL II -- Blended BMI Chart, p.17 ("Transamerica
// - Lifetime Whole Life Underwriting Field Guide.pdf"). The source has two
// age-banded tables (16-59 and 60+) that are IDENTICAL above BMI 28.0001 --
// they only diverge at the very bottom band (16.0001-18.0000 BMI), where
// under-60 gets "Nontobacco & Tobacco" and 60+ gets "Individual
// Consideration". Client age isn't passed into this cross-check (see
// crossCheckBuild), so this table uses the 60+ (more conservative) bottom
// band for that narrow BMI range and is otherwise age-blind and accurate
// across the full range. Applied to FCIUL II by inference only -- FCIUL
// II's own agent guide points to an external "Field Guide to Underwriting"
// that was not itself one of the 26 ingested documents; this is the closest
// match found, not a confirmed identical source. Deliberately NOT applied to
// plain (non-Express) FFIUL II for the same reason -- see the a1c-adjacent
// noVariantNote below and the Phase 1 discrepancy report.
const TRANSAMERICA_LIFETIME_BLENDED_BMI_BANDS = [
  { min: -Infinity, max: 16.0000, class: "Decline" },
  { min: 16.0001, max: 18.0000, class: "Individual Consideration (60+ band; under-60 would be Nontobacco & Tobacco -- age not available to this cross-check)" },
  { min: 18.0001, max: 28.0000, class: "Preferred Elite" },
  { min: 28.0001, max: 30.0000, class: "Preferred Plus / Preferred Tobacco" },
  { min: 30.0001, max: 32.0000, class: "Preferred" },
  { min: 32.0001, max: 35.0000, class: "Nontobacco & Tobacco" },
  { min: 35.0001, max: 37.0000, class: "Table A" },
  { min: 37.0001, max: 39.0000, class: "Table B" },
  { min: 39.0001, max: 41.0000, class: "Table C" },
  { min: 41.0001, max: 42.0000, class: "Table D" },
  { min: 42.0001, max: 43.0000, class: "Table E" },
  { min: 43.0001, max: 44.0000, class: "Table F" },
  { min: 44.0001, max: 46.0000, class: "Table H" },
  { min: 46.0001, max: Infinity, class: "Decline" },
];

// FFIUL II Express -- Adult BMI chart, p.32 ("Transamerica - FFIUL II
// Express Agent and Underwriting Guide.pdf"). Height/weight bounds within a
// BMI window, single "Select" outcome (this product is Decline/Select
// only). Two age bands (16-59, 60-75) with MEANINGFULLY DIFFERENT weight
// bounds at every height (unlike the Lifetime chart above, this isn't a
// narrow-edge-case difference), so this variant is intentionally NOT
// age-blended -- crossCheckBuild returns a no_client_data gap for it instead
// of guessing an age band. Recorded here for when client age is added to
// the intake/cross-check pipeline.
const TRANSAMERICA_FFIUL_II_EXPRESS_BMI_TABLE = {
  "16-59": [
    { heightIn: 56, min: 72, max: 173 }, { heightIn: 57, min: 74, max: 180 }, { heightIn: 58, min: 77, max: 186 },
    { heightIn: 59, min: 80, max: 193 }, { heightIn: 60, min: 82, max: 199 }, { heightIn: 61, min: 85, max: 206 },
    { heightIn: 62, min: 88, max: 213 }, { heightIn: 63, min: 91, max: 220 }, { heightIn: 64, min: 94, max: 227 },
    { heightIn: 65, min: 97, max: 234 }, { heightIn: 66, min: 100, max: 241 }, { heightIn: 67, min: 103, max: 249 },
    { heightIn: 68, min: 106, max: 256 }, { heightIn: 69, min: 109, max: 264 }, { heightIn: 70, min: 112, max: 271 },
    { heightIn: 71, min: 115, max: 279 }, { heightIn: 72, min: 119, max: 287 }, { heightIn: 73, min: 122, max: 295 },
    { heightIn: 74, min: 125, max: 303 }, { heightIn: 75, min: 129, max: 312 }, { heightIn: 76, min: 132, max: 320 },
    { heightIn: 77, min: 135, max: 328 }, { heightIn: 78, min: 139, max: 337 }, { heightIn: 79, min: 143, max: 346 },
    { heightIn: 80, min: 146, max: 355 }, { heightIn: 81, min: 150, max: 364 }, { heightIn: 82, min: 154, max: 373 },
    { heightIn: 83, min: 157, max: 382 }, { heightIn: 84, min: 161, max: 391 },
  ],
  "60-75": [
    { heightIn: 56, min: 81, max: 173 }, { heightIn: 57, min: 84, max: 180 }, { heightIn: 58, min: 87, max: 186 },
    { heightIn: 59, min: 90, max: 193 }, { heightIn: 60, min: 93, max: 199 }, { heightIn: 61, min: 96, max: 206 },
    { heightIn: 62, min: 99, max: 213 }, { heightIn: 63, min: 102, max: 220 }, { heightIn: 64, min: 105, max: 227 },
    { heightIn: 65, min: 109, max: 234 }, { heightIn: 66, min: 112, max: 241 }, { heightIn: 67, min: 115, max: 249 },
    { heightIn: 68, min: 119, max: 256 }, { heightIn: 69, min: 122, max: 264 }, { heightIn: 70, min: 126, max: 271 },
    { heightIn: 71, min: 130, max: 279 }, { heightIn: 72, min: 133, max: 287 }, { heightIn: 73, min: 137, max: 295 },
    { heightIn: 74, min: 141, max: 303 }, { heightIn: 75, min: 145, max: 312 }, { heightIn: 76, min: 148, max: 320 },
    { heightIn: 77, min: 152, max: 328 }, { heightIn: 78, min: 156, max: 337 }, { heightIn: 79, min: 160, max: 346 },
    { heightIn: 80, min: 164, max: 355 }, { heightIn: 81, min: 169, max: 364 }, { heightIn: 82, min: 173, max: 373 },
    { heightIn: 83, min: 177, max: 382 }, { heightIn: 84, min: 181, max: 391 },
  ],
};

// --- Allianz build charts ------------------------------------------------

// Allianz M-3405 -- Unisex build chart, p.3. Height/weight-based. Each row: a
// universal minimum weight (underweight boundary, same across classes at
// that height), then a maximum qualifying weight per rate class -- exceeding
// a class's max drops to the next-lower class, exceeding Standard is
// individual consideration / decline territory (refined below by the
// substandard Table-rating chart).
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

// Allianz M-3405 -- Table ratings for build, p.4. Consulted ONLY once a
// client's weight already exceeds every rate class in ALLIANZ_BUILD_CHART
// (i.e. lands in that chart's "above table range" fallback). Each field is
// the upper bound of that Table's weight band; bands are contiguous, so the
// same ascending-threshold walk used elsewhere works here too. Above
// table12Max: Individual Consideration, per the chart's own footnote.
const ALLIANZ_TABLE_RATING_CHART = [
  { heightIn: 56, table3Max: 185, table4Max: 189, table5Max: 194, table6Max: 198, table7Max: 202, table8Max: 207, table10Max: 211, table12Max: 216 },
  { heightIn: 57, table3Max: 191, table4Max: 196, table5Max: 201, table6Max: 205, table7Max: 210, table8Max: 214, table10Max: 219, table12Max: 224 },
  { heightIn: 58, table3Max: 198, table4Max: 203, table5Max: 208, table6Max: 212, table7Max: 217, table8Max: 222, table10Max: 227, table12Max: 232 },
  { heightIn: 59, table3Max: 205, table4Max: 210, table5Max: 215, table6Max: 220, table7Max: 225, table8Max: 230, table10Max: 235, table12Max: 240 },
  { heightIn: 60, table3Max: 212, table4Max: 217, table5Max: 222, table6Max: 227, table7Max: 232, table8Max: 238, table10Max: 243, table12Max: 248 },
  { heightIn: 61, table3Max: 219, table4Max: 224, table5Max: 230, table6Max: 235, table7Max: 240, table8Max: 246, table10Max: 251, table12Max: 256 },
  { heightIn: 62, table3Max: 226, table4Max: 232, table5Max: 237, table6Max: 243, table7Max: 248, table8Max: 254, table10Max: 259, table12Max: 265 },
  { heightIn: 63, table3Max: 234, table4Max: 239, table5Max: 245, table6Max: 251, table7Max: 256, table8Max: 262, table10Max: 268, table12Max: 273 },
  { heightIn: 64, table3Max: 241, table4Max: 247, table5Max: 253, table6Max: 259, table7Max: 265, table8Max: 270, table10Max: 275, table12Max: 282 },
  { heightIn: 65, table3Max: 249, table4Max: 255, table5Max: 261, table6Max: 267, table7Max: 273, table8Max: 279, table10Max: 285, table12Max: 291 },
  { heightIn: 66, table3Max: 257, table4Max: 263, table5Max: 269, table6Max: 275, table7Max: 281, table8Max: 288, table10Max: 294, table12Max: 300 },
  { heightIn: 67, table3Max: 264, table4Max: 271, table5Max: 277, table6Max: 284, table7Max: 290, table8Max: 296, table10Max: 303, table12Max: 309 },
  { heightIn: 68, table3Max: 272, table4Max: 279, table5Max: 286, table6Max: 292, table7Max: 299, table8Max: 305, table10Max: 312, table12Max: 318 },
  { heightIn: 69, table3Max: 281, table4Max: 287, table5Max: 294, table6Max: 301, table7Max: 308, table8Max: 314, table10Max: 321, table12Max: 328 },
  { heightIn: 70, table3Max: 289, table4Max: 296, table5Max: 303, table6Max: 310, table7Max: 317, table8Max: 324, table10Max: 331, table12Max: 338 },
  { heightIn: 71, table3Max: 297, table4Max: 304, table5Max: 311, table6Max: 319, table7Max: 326, table8Max: 333, table10Max: 340, table12Max: 347 },
  { heightIn: 72, table3Max: 305, table4Max: 313, table5Max: 320, table6Max: 328, table7Max: 335, table8Max: 342, table10Max: 350, table12Max: 357 },
  { heightIn: 73, table3Max: 314, table4Max: 322, table5Max: 329, table6Max: 337, table7Max: 344, table8Max: 352, table10Max: 360, table12Max: 367 },
  { heightIn: 74, table3Max: 323, table4Max: 331, table5Max: 338, table6Max: 346, table7Max: 354, table8Max: 362, table10Max: 369, table12Max: 377 },
  { heightIn: 75, table3Max: 332, table4Max: 340, table5Max: 348, table6Max: 356, table7Max: 363, table8Max: 372, table10Max: 380, table12Max: 388 },
  { heightIn: 76, table3Max: 340, table4Max: 349, table5Max: 357, table6Max: 365, table7Max: 373, table8Max: 382, table10Max: 390, table12Max: 398 },
  { heightIn: 77, table3Max: 349, table4Max: 358, table5Max: 366, table6Max: 375, table7Max: 383, table8Max: 392, table10Max: 400, table12Max: 408 },
  { heightIn: 78, table3Max: 359, table4Max: 367, table5Max: 376, table6Max: 385, table7Max: 393, table8Max: 402, table10Max: 411, table12Max: 419 },
  { heightIn: 79, table3Max: 368, table4Max: 377, table5Max: 386, table6Max: 395, table7Max: 403, table8Max: 412, table10Max: 421, table12Max: 430 },
  { heightIn: 80, table3Max: 377, table4Max: 386, table5Max: 395, table6Max: 405, table7Max: 414, table8Max: 423, table10Max: 432, table12Max: 441 },
];

// --- Foresters build charts (five distinct charts) ------------------------

// 1) Adult Build Chart (16+), Fully Underwritten -- p.10 of the Main UW
// Guide ("Foresters - Underwriting Guide (Your Term, Strong Foundation,
// Advantage Plus II, SMART UL) Apr2026.pdf"; the differently-named original
// filename is content-identical). Applies to Your Term, Strong Foundation,
// SMART UL, and Advantage Plus II -- the non-med platform's default/general
// chart. Extended through 6'9" via a fresh full-document re-read
// (2026-07-31); previously transcribed only through 6'7" with a null
// standardMax at that row -- both are now corrected from the source table.
const FORESTERS_BUILD_CHART_FULLY_UW = [
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
  { heightIn: 79, preferredPlusOrSmokerMax: 249, preferredMax: 265, standardPlusMax: 276, standardMax: 323 },
  { heightIn: 80, preferredPlusOrSmokerMax: 254, preferredMax: 270, standardPlusMax: 281, standardMax: 332 },
  { heightIn: 81, preferredPlusOrSmokerMax: 259, preferredMax: 273, standardPlusMax: 285, standardMax: 340 },
];

// 2) Adult Build Chart (16+), Non-Medical -- p.11 of the Main UW Guide.
// Single min/max range (no rate-class tiers), used specifically for non-med
// issuance when the applicant has no ratable impairments other than
// height/weight. More permissive than the Fully-Underwritten chart above at
// every height.
const FORESTERS_BUILD_CHART_NON_MEDICAL = [
  { heightIn: 56, minWeight: 74, maxWeight: 189 }, { heightIn: 57, minWeight: 77, maxWeight: 196 },
  { heightIn: 58, minWeight: 79, maxWeight: 203 }, { heightIn: 59, minWeight: 82, maxWeight: 210 },
  { heightIn: 60, minWeight: 85, maxWeight: 217 }, { heightIn: 61, minWeight: 88, maxWeight: 224 },
  { heightIn: 62, minWeight: 91, maxWeight: 232 }, { heightIn: 63, minWeight: 94, maxWeight: 239 },
  { heightIn: 64, minWeight: 97, maxWeight: 247 }, { heightIn: 65, minWeight: 100, maxWeight: 255 },
  { heightIn: 66, minWeight: 103, maxWeight: 263 }, { heightIn: 67, minWeight: 106, maxWeight: 271 },
  { heightIn: 68, minWeight: 109, maxWeight: 279 }, { heightIn: 69, minWeight: 112, maxWeight: 287 },
  { heightIn: 70, minWeight: 115, maxWeight: 296 }, { heightIn: 71, minWeight: 119, maxWeight: 304 },
  { heightIn: 72, minWeight: 122, maxWeight: 313 }, { heightIn: 73, minWeight: 126, maxWeight: 322 },
  { heightIn: 74, minWeight: 129, maxWeight: 330 }, { heightIn: 75, minWeight: 132, maxWeight: 339 },
  { heightIn: 76, minWeight: 136, maxWeight: 349 }, { heightIn: 77, minWeight: 140, maxWeight: 358 },
  { heightIn: 78, minWeight: 143, maxWeight: 367 }, { heightIn: 79, minWeight: 147, maxWeight: 377 },
  { heightIn: 80, minWeight: 151, maxWeight: 386 }, { heightIn: 81, minWeight: 154, maxWeight: 396 },
];

// 3) Juvenile Build Chart (age 0-15) -- p.12 of the Main UW Guide. Two
// distinct lookup styles by age: ages 0-2 use a length(in)/weight(lbs)
// range; ages 3-15 use a BMI range. Applies to BrightFuture. NOT currently
// usable by crossCheckBuild -- its inputs (heightIn/weightLbs only, no
// client age) can't select the right age band or distinguish the ages-0-2
// length-based check from the ages-3-15 BMI-based one. Recorded here for
// when client age is added to the intake/cross-check pipeline; until then
// this variant always returns a no_client_data gap, not a fabricated class.
const FORESTERS_JUVENILE_INFANT_LENGTH_WEIGHT = [
  { ageYears: 0, lengthInMin: 18, lengthInMax: 30, weightLbsMin: 4, weightLbsMax: 33 },
  { ageYears: 1, lengthInMin: 24, lengthInMax: 37, weightLbsMin: 11, weightLbsMax: 46 },
  { ageYears: 2, lengthInMin: 29, lengthInMax: 40, weightLbsMin: 16, weightLbsMax: 52 },
];
const FORESTERS_JUVENILE_BMI_BY_AGE = [
  { ageYears: 3, bmiMin: 13.5, bmiMax: 26.1 }, { ageYears: 4, bmiMin: 13.2, bmiMax: 25.3 },
  { ageYears: 5, bmiMin: 13.0, bmiMax: 25.6 }, { ageYears: 6, bmiMin: 12.9, bmiMax: 26.4 },
  { ageYears: 7, bmiMin: 12.9, bmiMax: 27.6 }, { ageYears: 8, bmiMin: 12.9, bmiMax: 29.0 },
  { ageYears: 9, bmiMin: 12.9, bmiMax: 30.5 }, { ageYears: 10, bmiMin: 13.1, bmiMax: 32.2 },
  { ageYears: 11, bmiMin: 13.4, bmiMax: 31.4 }, { ageYears: 12, bmiMin: 13.7, bmiMax: 32.8 },
  { ageYears: 13, bmiMin: 14.1, bmiMax: 34.2 }, { ageYears: 14, bmiMin: 14.6, bmiMax: 35.4 },
  { ageYears: 15, bmiMin: 15.1, bmiMax: 36.6 },
];

// 4) Accelerated Underwriting Program build guidelines -- p.2 of "Foresters
// - Accelerated Underwriting Program Guide.pdf". Single min/max range (no
// rate-class tiers -- these are eligibility bounds for the accelerated PATH
// itself, not a rate-class chart); applicants outside these bounds fall out
// of Accelerated eligibility into standard medically-underwritten review
// rather than an outright decline. Applies to Your Term, SMART UL, and
// Advantage Plus II specifically when the Accelerated Underwriting program
// is in play (Strong Foundation, PlanRight, and BrightFuture are excluded
// from this program entirely).
const FORESTERS_ACCELERATED_BUILD_CHART = [
  { heightIn: 56, minWeight: 74, maxWeight: 162 }, { heightIn: 57, minWeight: 77, maxWeight: 168 },
  { heightIn: 58, minWeight: 79, maxWeight: 174 }, { heightIn: 59, minWeight: 82, maxWeight: 180 },
  { heightIn: 60, minWeight: 85, maxWeight: 186 }, { heightIn: 61, minWeight: 88, maxWeight: 193 },
  { heightIn: 62, minWeight: 91, maxWeight: 199 }, { heightIn: 63, minWeight: 94, maxWeight: 206 },
  { heightIn: 64, minWeight: 97, maxWeight: 211 }, { heightIn: 65, minWeight: 100, maxWeight: 219 },
  { heightIn: 66, minWeight: 103, maxWeight: 226 }, { heightIn: 67, minWeight: 106, maxWeight: 233 },
  { heightIn: 68, minWeight: 109, maxWeight: 240 }, { heightIn: 69, minWeight: 112, maxWeight: 247 },
  { heightIn: 70, minWeight: 115, maxWeight: 254 }, { heightIn: 71, minWeight: 119, maxWeight: 261 },
  { heightIn: 72, minWeight: 122, maxWeight: 269 }, { heightIn: 73, minWeight: 126, maxWeight: 276 },
  { heightIn: 74, minWeight: 129, maxWeight: 284 }, { heightIn: 75, minWeight: 132, maxWeight: 292 },
  { heightIn: 76, minWeight: 136, maxWeight: 299 }, { heightIn: 77, minWeight: 140, maxWeight: 307 },
  { heightIn: 78, minWeight: 143, maxWeight: 315 }, { heightIn: 79, minWeight: 147, maxWeight: 323 },
  { heightIn: 80, minWeight: 151, maxWeight: 332 }, { heightIn: 81, minWeight: 154, maxWeight: 340 },
];

// 5) PlanRight Build Chart -- p.3 of "Foresters - PlanRight Medical
// Reference Guide.pdf". Height/weight-based with 3 rate-class tiers
// (Preferred, Standard, Basic) plus a shared minimum weight; applies only to
// PlanRight.
const FORESTERS_PLANRIGHT_BUILD_CHART = [
  { heightIn: 56, minWeight: 74, preferredMax: 201, standardMax: 216, basicMax: 232 },
  { heightIn: 57, minWeight: 77, preferredMax: 208, standardMax: 223, basicMax: 239 },
  { heightIn: 58, minWeight: 80, preferredMax: 215, standardMax: 230, basicMax: 246 },
  { heightIn: 59, minWeight: 83, preferredMax: 222, standardMax: 237, basicMax: 253 },
  { heightIn: 60, minWeight: 86, preferredMax: 229, standardMax: 245, basicMax: 262 },
  { heightIn: 61, minWeight: 89, preferredMax: 237, standardMax: 253, basicMax: 271 },
  { heightIn: 62, minWeight: 92, preferredMax: 246, standardMax: 262, basicMax: 280 },
  { heightIn: 63, minWeight: 95, preferredMax: 253, standardMax: 269, basicMax: 288 },
  { heightIn: 64, minWeight: 98, preferredMax: 260, standardMax: 278, basicMax: 297 },
  { heightIn: 65, minWeight: 101, preferredMax: 268, standardMax: 286, basicMax: 306 },
  { heightIn: 66, minWeight: 104, preferredMax: 275, standardMax: 294, basicMax: 315 },
  { heightIn: 67, minWeight: 107, preferredMax: 284, standardMax: 304, basicMax: 325 },
  { heightIn: 68, minWeight: 110, preferredMax: 292, standardMax: 313, basicMax: 334 },
  { heightIn: 69, minWeight: 113, preferredMax: 299, standardMax: 321, basicMax: 343 },
  { heightIn: 70, minWeight: 117, preferredMax: 308, standardMax: 330, basicMax: 353 },
  { heightIn: 71, minWeight: 121, preferredMax: 316, standardMax: 339, basicMax: 362 },
  { heightIn: 72, minWeight: 125, preferredMax: 325, standardMax: 348, basicMax: 372 },
  { heightIn: 73, minWeight: 129, preferredMax: 333, standardMax: 356, basicMax: 381 },
  { heightIn: 74, minWeight: 133, preferredMax: 341, standardMax: 366, basicMax: 391 },
  { heightIn: 75, minWeight: 137, preferredMax: 349, standardMax: 373, basicMax: 399 },
  { heightIn: 76, minWeight: 142, preferredMax: 357, standardMax: 382, basicMax: 409 },
  { heightIn: 77, minWeight: 147, preferredMax: 365, standardMax: 392, basicMax: 419 },
  { heightIn: 78, minWeight: 152, preferredMax: 373, standardMax: 406, basicMax: 434 },
  { heightIn: 79, minWeight: 159, preferredMax: 381, standardMax: 413, basicMax: 442 },
  { heightIn: 80, minWeight: 162, preferredMax: 389, standardMax: 421, basicMax: 450 },
  { heightIn: 81, minWeight: 167, preferredMax: 397, standardMax: 430, basicMax: 460 },
];

// --- F&G build charts -----------------------------------------------------

// F&G National Guard Field Underwriting Guide (ADV5601) -- Height/Weight
// Chart, p.5. Single min/max range (no rate-class tiers). SCOPED ONLY to F&G
// Everlast/Pathsetter applications submitted through the National Guard
// program (active Guard members + spouses/dependents) -- the general F&G
// Impairment Field Underwriting Guide (ADV5544), which governs F&G's
// broader Everlast/Pathsetter business, still has NO build chart at all, and
// that general-case gap is preserved below (no isDefault variant for F&G).
const FG_NATIONAL_GUARD_BUILD_CHART = [
  { heightIn: 56, minWeight: 74, maxWeight: 187 }, { heightIn: 57, minWeight: 76, maxWeight: 194 },
  { heightIn: 58, minWeight: 79, maxWeight: 201 }, { heightIn: 59, minWeight: 82, maxWeight: 208 },
  { heightIn: 60, minWeight: 84, maxWeight: 215 }, { heightIn: 61, minWeight: 87, maxWeight: 222 },
  { heightIn: 62, minWeight: 90, maxWeight: 230 }, { heightIn: 63, minWeight: 93, maxWeight: 237 },
  { heightIn: 64, minWeight: 96, maxWeight: 245 }, { heightIn: 65, minWeight: 99, maxWeight: 252 },
  { heightIn: 66, minWeight: 102, maxWeight: 260 }, { heightIn: 67, minWeight: 105, maxWeight: 268 },
  { heightIn: 68, minWeight: 109, maxWeight: 276 }, { heightIn: 69, minWeight: 112, maxWeight: 284 },
  { heightIn: 70, minWeight: 115, maxWeight: 293 }, { heightIn: 71, minWeight: 118, maxWeight: 301 },
  { heightIn: 72, minWeight: 122, maxWeight: 310 }, { heightIn: 73, minWeight: 125, maxWeight: 318 },
  { heightIn: 74, minWeight: 129, maxWeight: 327 }, { heightIn: 75, minWeight: 132, maxWeight: 336 },
  { heightIn: 76, minWeight: 136, maxWeight: 345 }, { heightIn: 77, minWeight: 139, maxWeight: 354 },
  { heightIn: 78, minWeight: 143, maxWeight: 363 }, { heightIn: 79, minWeight: 145, maxWeight: 373 },
  { heightIn: 80, minWeight: 160, maxWeight: 382 }, { heightIn: 81, minWeight: 164, maxWeight: 392 },
  { heightIn: 82, minWeight: 168, maxWeight: 402 }, { heightIn: 83, minWeight: 172, maxWeight: 408 },
  { heightIn: 84, minWeight: 176, maxWeight: 415 },
];

export const NUMERIC_LOOKUP = {
  transamerica: {
    build: {
      available: true,
      noVariantNote: "Transamerica has multiple distinct build/BMI standards by product (FE Express Solution's simple 3-band BMI chart, Transamerica Lifetime/FCIUL II's 13-tier Blended BMI Chart, and FFIUL II Express's own age-banded chart), and the recommended product wasn't specific enough -- or was plain/non-Express FFIUL II, which has no confirmed chart of its own in the ingested documents -- to select the right one.",
      variants: [
        { id: "fe_express", label: "FE Express Solution Adult Build Chart", matchKeywords: ["fe express"], kind: "bmi_bands", sourceDocId: "transamerica_fe_express", sourcePage: 14, data: TRANSAMERICA_FEX_BMI_BANDS },
        { id: "lifetime_blended", label: "Transamerica Lifetime / FCIUL II Blended BMI Chart", matchKeywords: ["lifetime", "fciul", "financial choice iul"], kind: "bmi_bands", sourceDocId: "transamerica_lifetime_field_guide", sourcePage: 17, data: TRANSAMERICA_LIFETIME_BLENDED_BMI_BANDS, caveat: "Age-blended (see chart comment): uses the more conservative 60+ classification at the narrow 16.0001-18.0000 BMI band since client age isn't passed to this cross-check." },
        {
          id: "ffiul_ii_express", label: "FFIUL II Express Adult BMI chart",
          matchKeywords: ["ffiul ii express", "financial foundation iul ii express", "financial foundation iul® ii express", "ffiul® ii express"],
          kind: "requires_age", sourceDocId: "transamerica_ffiul_ii_express", sourcePage: 32, data: TRANSAMERICA_FFIUL_II_EXPRESS_BMI_TABLE,
          note: "FFIUL II Express's BMI chart is meaningfully age-banded (16-59 vs 60-75, different weight bounds at every height) and client age wasn't available to this cross-check for this case.",
        },
      ],
    },
    a1c: { available: false, note: "Confirmed carrier-wide across all 6 ingested Transamerica documents: FE Express gates diabetes on an insulin-use flag, Lifetime WL caps diabetes at Standard rate class regardless of A1C, and FFIUL II Express declines diabetes via an age-of-diagnosis/insulin/complication flag combination -- no Transamerica product uses a numeric A1C cutoff." },
    psa: { available: false, note: "No PSA/prostate numeric threshold found in any of the 6 ingested Transamerica documents." },
  },
  allianz: {
    build: {
      available: true,
      variants: [
        {
          id: "base_chart", label: "Allianz M-3405 Unisex Build Chart", isDefault: true,
          kind: "height_weight_tiered", sourceDocId: "allianz_uw_guide", sourcePage: 3, data: ALLIANZ_BUILD_CHART,
          classFields: [
            { field: "preferredPlusNontobaccoMax", label: "Preferred Plus Nontobacco" },
            { field: "preferredNontobaccoMax", label: "Preferred Nontobacco" },
            { field: "standardNontobaccoMax", label: "Standard Nontobacco" },
          ],
        },
      ],
    },
    a1c: { available: false, note: "M-3405's Preferred-tier eligibility table gates diabetes as a binary 'no history of diabetes' exclusion for Preferred classes, no numeric A1C cutoff appears in the ingested document." },
    psa: { available: false, note: "No PSA/prostate numeric threshold found in the ingested Allianz documents." },
  },
  foresters: {
    build: {
      available: true,
      variants: [
        {
          id: "adult_fully_uw", label: "Adult Build Chart (16+), Fully Underwritten",
          matchKeywords: ["your term", "strong foundation", "smart ul", "advantage plus ii"], isDefault: true,
          kind: "height_weight_tiered", sourceDocId: "foresters_main_uw_apr26", sourcePage: 10, data: FORESTERS_BUILD_CHART_FULLY_UW,
          classFields: [
            { field: "preferredPlusOrSmokerMax", label: "Preferred Plus / Preferred Smoker" },
            { field: "preferredMax", label: "Preferred" },
            { field: "standardPlusMax", label: "Standard Plus" },
            { field: "standardMax", label: "Standard" },
          ],
        },
        {
          id: "adult_non_medical", label: "Adult Build Chart (16+), Non-Medical",
          matchKeywords: ["non-medical issue", "non medical issue"],
          kind: "height_weight_minmax", sourceDocId: "foresters_main_uw_apr26", sourcePage: 11, data: FORESTERS_BUILD_CHART_NON_MEDICAL,
        },
        {
          id: "juvenile", label: "Juvenile Build Chart (age 0-15)", matchKeywords: ["brightfuture"],
          kind: "requires_age", sourceDocId: "foresters_main_uw_apr26", sourcePage: 12,
          note: "BrightFuture's Juvenile Build Chart is age-banded (infant length/weight for ages 0-2, BMI-by-age for ages 3-15) and client age wasn't available to this cross-check for this case.",
        },
        {
          id: "accelerated_uw", label: "Accelerated Underwriting Program build guidelines", matchKeywords: ["accelerated underwriting"],
          kind: "height_weight_minmax", sourceDocId: "foresters_accelerated_uw_guide", sourcePage: 2, data: FORESTERS_ACCELERATED_BUILD_CHART,
        },
        {
          id: "planright", label: "PlanRight Build Chart", matchKeywords: ["planright"],
          kind: "height_weight_tiered", sourceDocId: "foresters_planright_medical_ref", sourcePage: 3, data: FORESTERS_PLANRIGHT_BUILD_CHART,
          classFields: [
            { field: "preferredMax", label: "PlanRight Preferred" },
            { field: "standardMax", label: "PlanRight Standard" },
            { field: "basicMax", label: "PlanRight Basic" },
          ],
        },
      ],
    },
    a1c: {
      available: true,
      threshold: 8.9,
      appliesToProducts: ["your term", "advantage plus ii", "smart ul"],
      outOfScopeNote: "Foresters' 8.9% A1C ceiling only applies to Your Term/Advantage Plus II/SMART UL non-med business (per the 'Diabetes Ratings for Non-Med Business' worksheet). Strong Foundation uses a separate Diabetes Tables 7-12 / Individual Consideration track with no numeric A1C cutoff of its own; PlanRight and BrightFuture flat-decline diabetes regardless of A1C. The recommended product wasn't in scope (or wasn't specified) for this threshold.",
      sourceDocId: "foresters_diabetes_ratings_nonmed", sourcePage: 1,
    },
    psa: { available: false, note: "No PSA/prostate numeric threshold found in any of the 8 ingested Foresters documents." },
  },
  fg: {
    build: {
      available: true,
      noVariantNote: "No general F&G build/BMI chart exists (confirmed gap in the Impairment Field Underwriting Guide ADV5544, and separately flagged in the user's own MASTER INDEX.txt for the local underwriting library). A National Guard-specific chart exists, but only applies to F&G Everlast/Pathsetter applications submitted through the National Guard program -- the recommended product must name that program to use it.",
      variants: [
        {
          id: "national_guard", label: "F&G National Guard Height/Weight Chart", matchKeywords: ["national guard"],
          kind: "height_weight_minmax", sourceDocId: "fg_national_guard_guide", sourcePage: 5, data: FG_NATIONAL_GUARD_BUILD_CHART,
        },
        // Deliberately no isDefault variant here -- the general F&G
        // Impairment Field Underwriting Guide genuinely has no build chart,
        // so an unspecified/general F&G product correctly stays
        // unavailable rather than silently borrowing the National-Guard
        // -only chart.
      ],
    },
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

function matchesKeywords(product, keywords) {
  if (!product || !keywords?.length) return false;
  const p = String(product).toLowerCase();
  return keywords.some((k) => p.includes(k));
}

// Picks the right build-chart variant for a carrier given the recommended
// product's free-text name: an explicit keyword match wins if present,
// otherwise falls back to the variant flagged isDefault (if any). Returns
// null when nothing matches and there's no default -- callers must treat
// that as "carrier has build data, but not for this specific product/scope".
function selectVariant(variants, product) {
  if (!variants?.length) return null;
  if (product) {
    const specific = variants.find((v) => matchesKeywords(product, v.matchKeywords));
    if (specific) return specific;
  }
  return variants.find((v) => v.isDefault) || null;
}

// Looks up the nearest exact-height row (charts are per-inch, so this is an
// exact match, not interpolation) and returns the qualifying rate class for
// a given weight (walking classFields in ascending-max order), plus the raw
// row for display. Returns null if the height isn't covered by the table.
function classifyHeightWeightTiered(table, heightIn, weightLbs, classFields) {
  const row = table.find((r) => r.heightIn === heightIn);
  if (!row) return null;
  for (const { field, label } of classFields) {
    const max = row[field];
    if (max != null && weightLbs <= max) return { class: label, row };
  }
  return { class: "above table range (individual consideration / decline territory)", row };
}

// For charts with only a single min/max acceptable-build range (no
// rate-class tiers) -- e.g. Foresters' Non-Medical, Accelerated-UW, and F&G
// National Guard charts.
function classifyHeightWeightMinMax(table, heightIn, weightLbs) {
  const row = table.find((r) => r.heightIn === heightIn);
  if (!row) return null;
  if (weightLbs < row.minWeight) return { class: "below minimum weight for height (decline territory)", row };
  if (weightLbs > row.maxWeight) return { class: "above maximum weight for height (decline territory)", row };
  return { class: "within chart's acceptable build range", row };
}

function classifyBMI(bands, bmi) {
  for (const band of bands) {
    if (bmi >= band.min && bmi <= band.max) return band.class;
  }
  return "outside charted range (no coverage per chart footnote)";
}

// Allianz-specific: once a client's weight has already exceeded every rate
// class in ALLIANZ_BUILD_CHART, walk the substandard Table-rating chart
// (p.4) to give a precise Table X classification instead of the generic
// "above table range" fallback. Returns null if the height isn't covered.
function classifyAllianzSubstandardTable(heightIn, weightLbs) {
  const row = ALLIANZ_TABLE_RATING_CHART.find((r) => r.heightIn === heightIn);
  if (!row) return null;
  const fields = [
    { field: "table3Max", label: "Table 3 (175%)" },
    { field: "table4Max", label: "Table 4 (200%)" },
    { field: "table5Max", label: "Table 5 (225%)" },
    { field: "table6Max", label: "Table 6 (250%)" },
    { field: "table7Max", label: "Table 7 (275%)" },
    { field: "table8Max", label: "Table 8 (300%)" },
    { field: "table10Max", label: "Table 10 (350%)" },
    { field: "table12Max", label: "Table 12 (400%)" },
  ];
  for (const { field, label } of fields) {
    if (weightLbs <= row[field]) return label;
  }
  return "Individual Consideration (above Table 12/400%)";
}

// Foresters BrightFuture -- Juvenile Build Chart (age 0-15). Two age-band
// styles per the source: infant length/weight range for ages 0-2, BMI-by-age
// for ages 3-15 (heightIn is treated as length in inches for the infant
// band -- the only geometric measurement this cross-check receives). Returns
// null if the age/height combination isn't covered by the transcribed table,
// or { outOfRange: true } if ageYears falls outside 0-15 entirely (this
// chart doesn't apply -- BrightFuture's own issue age is 15 days-17, so ages
// 16-17 are real but simply have no juvenile chart row; treated the same as
// out-of-range here rather than guessing).
function classifyForestersJuvenile(ageYears, heightIn, weightLbs) {
  if (ageYears < 0 || ageYears > 15) return { outOfRange: true };
  const ageInt = Math.floor(ageYears);
  if (ageInt <= 2) {
    const row = FORESTERS_JUVENILE_INFANT_LENGTH_WEIGHT.find((r) => r.ageYears === ageInt);
    if (!row) return null;
    const withinLength = heightIn >= row.lengthInMin && heightIn <= row.lengthInMax;
    const withinWeight = weightLbs >= row.weightLbsMin && weightLbs <= row.weightLbsMax;
    const within = withinLength && withinWeight;
    return {
      class: within
        ? `within Foresters' infant length/weight guidelines for age ${ageInt}`
        : `outside Foresters' infant length/weight guidelines for age ${ageInt} -- individual consideration`,
      row,
    };
  }
  const row = FORESTERS_JUVENILE_BMI_BY_AGE.find((r) => r.ageYears === Math.round(ageYears));
  if (!row) return null;
  const bmi = bmiFromHeightWeight(heightIn, weightLbs);
  const within = bmi >= row.bmiMin && bmi <= row.bmiMax;
  return {
    class: within
      ? `BMI ${Math.round(bmi * 10) / 10} within Foresters' juvenile guidelines for age ${row.ageYears}`
      : `BMI ${Math.round(bmi * 10) / 10} outside Foresters' juvenile guidelines for age ${row.ageYears} -- individual consideration`,
    row, computedBMI: bmi,
  };
}

// Transamerica FFIUL II Express -- Adult BMI chart (age-banded: 16-59 vs
// 60-75). Decline/Select-only product -- "outside the Select range" doesn't
// itself mean Decline per the source text, but is the closest signal this
// chart gives; phrased as such below rather than asserting a firm Decline.
// Returns null if the height isn't covered by the selected age band's table,
// or { outOfRange: true } if ageYears falls outside both bands (16-75).
function classifyTransamericaFfiulExpress(ageYears, heightIn, weightLbs) {
  let band;
  if (ageYears >= 16 && ageYears <= 59) band = "16-59";
  else if (ageYears >= 60 && ageYears <= 75) band = "60-75";
  else return { outOfRange: true };
  const row = TRANSAMERICA_FFIUL_II_EXPRESS_BMI_TABLE[band].find((r) => r.heightIn === heightIn);
  if (!row) return null;
  const within = weightLbs >= row.min && weightLbs <= row.max;
  return {
    class: within ? "Select" : "outside the Select build range for this height/age (individual consideration / decline territory)",
    row, band,
  };
}

// The actual cross-check: given a carrier id, the client's stated
// height/weight/age, the rate class the final model's answer claimed, and
// the recommended product's free-text name (used only to pick the right
// build chart variant, see selectVariant), checks whether the lookup table
// agrees. Never used to pick or override an answer -- only to flag
// disagreement for human review. Returns {checked: false, reason} when
// there's no applicable lookup data (never a false flag), or {checked: true,
// agrees, lookupClass, detail}.
//
// `ageYears` comes from the pre-triage structured intake extraction (see
// extractClientIntake/INTAKE_TOOL in chat.mjs), NOT from the post-hoc
// clientNumerics used for height/weight/A1C/PSA -- it's threaded through
// from a different point in the pipeline than `product` is, but the intent
// is the same: only the two age-banded build variants (Foresters BrightFuture
// Juvenile, Transamerica FFIUL II Express) actually need it, and both
// honestly report no_client_data when it isn't available (follow-up turns,
// or a conversation with attached client documents, currently never run the
// intake extraction this age comes from) rather than guessing an age band.
export function crossCheckBuild({ carrier, heightIn, weightLbs, statedClass, product, ageYears }) {
  const carrierEntry = NUMERIC_LOOKUP[carrier]?.build;
  if (!carrierEntry?.available) {
    // A genuine carrier-side gap (no build chart exists for this carrier at
    // all in the ingested documents) -- distinct from the client simply not
    // having given height/weight, which is a client-data gap, not a
    // carrier one. Only the former belongs in the agent-facing dataGaps
    // note.
    return { checked: false, reasonType: "no_carrier_data", reason: carrierEntry?.note || "No build lookup data for this carrier." };
  }

  const variant = selectVariant(carrierEntry.variants, product);
  if (!variant) {
    return { checked: false, reasonType: "no_carrier_data", reason: carrierEntry.noVariantNote || `${carrier} has multiple distinct build charts by product and the recommended product wasn't specific enough to select the right one.` };
  }

  if (variant.kind === "requires_age") {
    if (ageYears == null) {
      return { checked: false, reasonType: "no_client_data", reason: variant.note };
    }
    if (heightIn == null || weightLbs == null) {
      return { checked: false, reasonType: "no_client_data", reason: "Client height/weight not both available to check." };
    }

    const classify = variant.id === "juvenile" ? classifyForestersJuvenile : classifyTransamericaFfiulExpress;
    const result = classify(ageYears, heightIn, weightLbs);
    if (!result) {
      return { checked: false, reasonType: "no_carrier_data", reason: `Age ${ageYears} / height ${heightIn}in not covered by the transcribed table range for ${variant.label}.` };
    }
    if (result.outOfRange) {
      return { checked: false, reasonType: "no_carrier_data", reason: `Client age ${ageYears} is outside ${variant.label}'s covered age range -- this variant doesn't apply.` };
    }
    const isOutside = /outside|decline/i.test(result.class);
    const agrees = statedClass ? (isOutside ? /decline|individual consideration/i.test(statedClass) : true) : null;
    return {
      checked: true, agrees, lookupClass: result.class,
      computedBMI: result.computedBMI != null ? Math.round(result.computedBMI * 10) / 10 : undefined,
      sourceDocId: variant.sourceDocId, sourcePage: variant.sourcePage,
      detail: `${result.class} per ${variant.label}, p.${variant.sourcePage}.`,
    };
  }

  if (heightIn == null || weightLbs == null) {
    return { checked: false, reasonType: "no_client_data", reason: "Client height/weight not both available to check." };
  }

  if (variant.kind === "bmi_bands") {
    const bmi = bmiFromHeightWeight(heightIn, weightLbs);
    const lookupClass = classifyBMI(variant.data, bmi);
    const agrees = statedClass ? String(statedClass).toLowerCase().includes(lookupClass.toLowerCase().split(" ")[0]) : null;
    return {
      checked: true, agrees, lookupClass, computedBMI: Math.round(bmi * 10) / 10,
      sourceDocId: variant.sourceDocId, sourcePage: variant.sourcePage,
      detail: `Computed BMI ${Math.round(bmi * 10) / 10} -> ${lookupClass} per ${variant.label}, p.${variant.sourcePage}.${variant.caveat ? " " + variant.caveat : ""}`,
    };
  }

  if (variant.kind === "height_weight_tiered") {
    const result = classifyHeightWeightTiered(variant.data, heightIn, weightLbs, variant.classFields);
    if (!result) {
      return { checked: false, reasonType: "no_carrier_data", reason: `Height ${heightIn}in not covered by the transcribed table range for ${variant.label}.` };
    }
    let lookupClass = result.class;
    let sourcePage = variant.sourcePage;
    let extraDetail = "";
    if (carrier === "allianz" && /above table range/.test(lookupClass)) {
      const substandard = classifyAllianzSubstandardTable(heightIn, weightLbs);
      if (substandard) {
        lookupClass = substandard;
        sourcePage = 4;
        extraDetail = " (via the M-3405 substandard Table-rating chart, p.4, since weight exceeds every base rate class)";
      }
    }
    const agrees = statedClass ? String(statedClass).toLowerCase().includes(lookupClass.toLowerCase().split(" ")[0].split("/")[0]) : null;
    return {
      checked: true, agrees, lookupClass,
      sourceDocId: variant.sourceDocId, sourcePage,
      detail: `${weightLbs}lbs at ${heightIn}in -> ${lookupClass} per ${variant.label}, p.${variant.sourcePage}.${extraDetail}`,
    };
  }

  if (variant.kind === "height_weight_minmax") {
    const result = classifyHeightWeightMinMax(variant.data, heightIn, weightLbs);
    if (!result) {
      return { checked: false, reasonType: "no_carrier_data", reason: `Height ${heightIn}in not covered by the transcribed table range for ${variant.label}.` };
    }
    const isDecline = /decline/i.test(result.class);
    const agrees = statedClass ? (isDecline ? /decline/i.test(statedClass) : !/decline/i.test(statedClass)) : null;
    return {
      checked: true, agrees, lookupClass: result.class,
      sourceDocId: variant.sourceDocId, sourcePage: variant.sourcePage,
      detail: `${weightLbs}lbs at ${heightIn}in -> ${result.class} per ${variant.label}, p.${variant.sourcePage}.`,
    };
  }

  return { checked: false, reasonType: "no_carrier_data", reason: "Unrecognized lookup kind." };
}

// A1C cross-check. Only Foresters currently has a numeric threshold, and
// only for a specific product subset -- see NUMERIC_LOOKUP.foresters.a1c.
// Every other carrier/product combination stays a genuine "no_carrier_data"
// gap, same as before.
export function crossCheckA1C({ carrier, a1c, statedOutcome, product }) {
  const entry = NUMERIC_LOOKUP[carrier]?.a1c;
  if (!entry?.available) {
    return { checked: false, reasonType: "no_carrier_data", reason: entry?.note || "No A1C lookup data for this carrier -- none of the four carriers' general-case documents use a numeric A1C cutoff." };
  }

  if (entry.appliesToProducts && !matchesKeywords(product, entry.appliesToProducts)) {
    return { checked: false, reasonType: "no_carrier_data", reason: entry.outOfScopeNote };
  }

  if (a1c == null) {
    return { checked: false, reasonType: "no_client_data", reason: "Client A1C not provided." };
  }

  const exceeds = a1c > entry.threshold;
  const lookupClass = exceeds
    ? `A1C ${a1c}% exceeds ${entry.threshold}% -- ineligible for non-med business, must be written fully underwritten`
    : `A1C ${a1c}% at or below the ${entry.threshold}% non-med threshold`;
  // Conservative agreement check, matching the style used elsewhere in this
  // module: below-threshold cases are assumed to agree (no reliable keyword
  // to check against, and the common case), while above-threshold cases only
  // flag a disagreement if the stated outcome text gives no indication the
  // case was routed off the non-med path (fully underwritten / individual
  // consideration / decline / referred) -- a coarse but honest check, never
  // a fabricated one.
  const agrees = statedOutcome
    ? (exceeds ? /fully underwrit|individual consideration|decline|refer/i.test(statedOutcome) : true)
    : null;

  return {
    checked: true, agrees, lookupClass,
    sourceDocId: entry.sourceDocId, sourcePage: entry.sourcePage,
    detail: `${lookupClass}, per Foresters' Diabetes Ratings for Non-Med Business worksheet, p.${entry.sourcePage}.`,
  };
}

export function crossCheckPSA({ carrier, psa, statedOutcome }) {
  const entry = NUMERIC_LOOKUP[carrier]?.psa;
  return { checked: false, reasonType: "no_carrier_data", reason: entry?.note || "No PSA lookup data for this carrier." };
}

export { feetInchesToTotalInches, bmiFromHeightWeight };
