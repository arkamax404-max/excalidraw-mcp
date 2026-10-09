/**
 * Local mirror of the Excalidraw server's diagram-name normalization.
 *
 * IMPORTANT: this mirrors the server's algorithm EXACTLY so the tool handlers
 * can tell the agent the canonical name in advance of the request; the server
 * remains the authority and its canonical name (echoed in every response)
 * always wins over this prediction.
 *
 * Server algorithm (fixed contract, T5):
 *  1. NFKC-normalize;
 *  2. replace every run of characters outside [\w\- ] with "-";
 *  3. replace whitespace runs with "-";
 *  4. collapse runs of "-" to a single "-";
 *  5. strip leading and trailing [-_. ];
 *  6. lowercase;
 *  7. if the result is empty, use "diagrama-1";
 *  8. truncate to 80 characters.
 */
export function normalizeDiagramName(raw: string): string {
  let name = raw.normalize("NFKC");
  name = name.replace(/[^\w\- ]+/g, "-");
  name = name.replace(/\s+/g, "-");
  name = name.replace(/-+/g, "-");
  name = name.replace(/^[-_. ]+|[-_. ]+$/g, "");
  name = name.toLowerCase();
  if (name === "") {
    name = "diagrama-1";
  }
  return name.slice(0, 80);
}
