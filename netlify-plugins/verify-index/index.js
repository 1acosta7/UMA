// Runs after every successful deploy and calls the live verify-index
// function, so an indexing gap (a document uploaded but never fully
// embedded, or embeddings orphaned by a deleted document) shows up in the
// deploy log automatically instead of only being noticed the next time
// someone happens to click "Verify Index" in Setup.
//
// Deliberately does NOT fail the build over a verification problem --
// existing-document indexing gaps aren't caused by whatever this deploy
// changed, and a UI tweak shouldn't be blocked by an unrelated data issue.
// This is a visibility check, not a gate.
module.exports = {
  onSuccess: async () => {
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL;
    const pin = process.env.ADMIN_PIN;

    if (!siteUrl) {
      console.log("[verify-index] No site URL available at this point in the build -- skipping post-deploy verification.");
      return;
    }
    if (!pin) {
      console.log("[verify-index] ADMIN_PIN not available at build time -- skipping post-deploy verification.");
      return;
    }

    try {
      const res = await fetch(`${siteUrl}/.netlify/functions/verify-index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const report = await res.json();

      if (!res.ok) {
        console.log(`[verify-index] Verification endpoint returned ${res.status}: ${report.error || "unknown error"}`);
        return;
      }
      if (report.error) {
        console.log(`[verify-index] Verification could not complete: ${report.error}`);
        return;
      }
      if (report.ok) {
        console.log(`[verify-index] OK -- all ${report.totalDocuments} carrier documents verified in the vector index.`);
        return;
      }

      console.log(`[verify-index] ISSUES FOUND -- ${report.problems.length} document(s) with problems, ${report.orphaned.length} orphaned entr${report.orphaned.length === 1 ? "y" : "ies"}.`);
      for (const p of report.problems) {
        console.log(`  - ${p.carrier}_${p.slotId} (${p.slotLabel}${p.sourceFilename ? `, ${p.sourceFilename}` : ""}): ${p.state}`);
      }
      for (const k of report.orphaned) {
        console.log(`  - orphaned entry with no matching upload: ${k}`);
      }
      console.log("[verify-index] Open Setup → Verify Index in the app for full details.");
    } catch (err) {
      console.log(`[verify-index] Could not reach verification endpoint: ${err.message}`);
    }
  },
};
