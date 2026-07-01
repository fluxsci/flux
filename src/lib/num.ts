// ---------------------------------------------------------------------------
// Safe arithmetic evaluator for the editor's numeric fields (Feature 8).
//
// Lets a user type `816/2`, `(240*3)+48`, `2^3`, `-5` into any numeric input for
// reproducible, low-arithmetic precision. Implemented as a tiny recursive-descent
// parser — NO `eval`/`Function` — over a whitelisted character set, so pasted
// project data can never smuggle code into an input handler.
//
// Grammar (standard precedence; `^` right-associative, unary +/-):
//   expr   := term (('+'|'-') term)*
//   term   := factor (('*'|'/') factor)*
//   factor := unary ('^' factor)?
//   unary  := ('+'|'-') unary | primary
//   primary:= number | '(' expr ')'
//
// Returns `null` for anything malformed OR a non-finite result (e.g. `1/0`), so
// callers keep the previous value instead of writing NaN/Infinity into the model.
// ---------------------------------------------------------------------------

export function evalExpr(input: string): number | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  // Whitelist first: digits, dot, the four operators, `^`, parens, whitespace.
  if (!/^[0-9.+\-*/^()\s]+$/.test(s)) return null;

  let i = 0;
  const peek = () => s[i];
  const skip = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  };

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left == null) return null;
    for (;;) {
      skip();
      const op = peek();
      if (op === "+" || op === "-") {
        i++;
        const right = parseTerm();
        if (right == null) return null;
        left = op === "+" ? left + right : left - right;
      } else break;
    }
    return left;
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left == null) return null;
    for (;;) {
      skip();
      const op = peek();
      if (op === "*" || op === "/") {
        i++;
        const right = parseFactor();
        if (right == null) return null;
        left = op === "*" ? left * right : left / right;
      } else break;
    }
    return left;
  }

  // Exponent, right-associative: 2^3^2 === 2^(3^2).
  function parseFactor(): number | null {
    const base = parseUnary();
    if (base == null) return null;
    skip();
    if (peek() === "^") {
      i++;
      const exp = parseFactor();
      if (exp == null) return null;
      return Math.pow(base, exp);
    }
    return base;
  }

  function parseUnary(): number | null {
    skip();
    const c = peek();
    if (c === "-") {
      i++;
      const v = parseUnary();
      return v == null ? null : -v;
    }
    if (c === "+") {
      i++;
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number | null {
    skip();
    if (peek() === "(") {
      i++;
      const v = parseExpr();
      if (v == null) return null;
      skip();
      if (peek() !== ")") return null;
      i++;
      return v;
    }
    const start = i;
    while (i < s.length && ((s[i] >= "0" && s[i] <= "9") || s[i] === ".")) i++;
    if (i === start) return null;
    const numStr = s.slice(start, i);
    if ((numStr.match(/\./g) || []).length > 1) return null; // reject "1.2.3"
    const n = Number(numStr);
    return Number.isFinite(n) ? n : null;
  }

  const result = parseExpr();
  if (result == null) return null;
  skip();
  if (i !== s.length) return null; // trailing garbage → invalid
  return Number.isFinite(result) ? result : null;
}

// Format a numeric value for display in a field: integers stay integer, else
// round to the precision implied by `step` (so a 0.05 opacity shows "0.85", a
// 1-unit x shows "408"). Trims float noise from scrub accumulation.
export function fmtNum(v: number, step = 1): string {
  if (!Number.isFinite(v)) return "0";
  const dp = step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0;
  return String(+v.toFixed(dp));
}
