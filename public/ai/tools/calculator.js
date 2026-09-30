/* ============================================================
   SaveHatke AI — calculator tool.

   Deterministic arithmetic where precision matters, so the assistant does
   not rely on the model's mental math. This is a real, safe expression
   evaluator: a hand-written recursive-descent parser over a tokenised
   input. It never uses eval() or the Function constructor, so no arbitrary
   code can execute here.

   Tool contract (name, description, schema, validate, run) matches the
   shared tool shape so more tools can be added the same way.
   ============================================================ */

const FUNCTIONS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  ln: Math.log, log: (x) => Math.log10(x), log2: Math.log2,
  exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
};
const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const src = input.replace(/\s+/g, '');
  while (i < src.length) {
    const ch = src[i];
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < src.length && /[0-9.eE+\-]/.test(src[i])) {
        // Only accept +/- as part of a number when it is an exponent sign.
        if ((src[i] === '+' || src[i] === '-') && !/[eE]/.test(src[i - 1])) break;
        num += src[i++];
      }
      const value = Number(num);
      if (!Number.isFinite(value)) throw new Error('invalid number: ' + num);
      tokens.push({ type: 'num', value });
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let name = '';
      while (i < src.length && /[a-zA-Z0-9]/.test(src[i])) name += src[i++];
      tokens.push({ type: 'name', value: name.toLowerCase() });
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    throw new Error('unexpected character: ' + ch);
  }
  return tokens;
}

/* Recursive-descent grammar:
     expr   := term (('+'|'-') term)*
     term   := factor (('*'|'/'|'%') factor)*
     factor := power
     power  := unary ('^' factor)?
     unary  := ('-'|'+')? primary
     primary:= num | name | name '(' expr ')' | '(' expr ')'          */
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (value) => {
    const t = tokens[pos];
    if (!t || (value !== undefined && t.value !== value)) {
      throw new Error('unexpected token near position ' + pos);
    }
    pos++;
    return t;
  };

  function expr() {
    let value = term();
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = eat().value;
      const rhs = term();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }
  function term() {
    let value = power();
    while (peek() && peek().type === 'op' && ['*', '/', '%'].includes(peek().value)) {
      const op = eat().value;
      const rhs = power();
      if (op === '*') value *= rhs;
      else if (op === '/') value /= rhs;
      else value %= rhs;
    }
    return value;
  }
  function power() {
    const base = unary();
    if (peek() && peek().type === 'op' && peek().value === '^') {
      eat('^');
      return Math.pow(base, factorRight());
    }
    return base;
  }
  // Exponent is right-associative.
  function factorRight() { return power(); }
  function unary() {
    if (peek() && peek().type === 'op' && (peek().value === '-' || peek().value === '+')) {
      const op = eat().value;
      const v = unary();
      return op === '-' ? -v : v;
    }
    return primary();
  }
  function primary() {
    const t = peek();
    if (!t) throw new Error('unexpected end of expression');
    if (t.type === 'num') { eat(); return t.value; }
    if (t.type === 'name') {
      eat();
      if (peek() && peek().type === 'op' && peek().value === '(') {
        eat('(');
        const arg = expr();
        eat(')');
        const fn = FUNCTIONS[t.value];
        if (!fn) throw new Error('unknown function: ' + t.value);
        return fn(arg);
      }
      if (t.value in CONSTANTS) return CONSTANTS[t.value];
      throw new Error('unknown name: ' + t.value);
    }
    if (t.type === 'op' && t.value === '(') {
      eat('(');
      const v = expr();
      eat(')');
      return v;
    }
    throw new Error('unexpected token: ' + t.value);
  }

  const result = expr();
  if (pos !== tokens.length) throw new Error('trailing tokens in expression');
  return result;
}

export function evaluate(expression) {
  const tokens = tokenize(String(expression));
  if (!tokens.length) throw new Error('empty expression');
  const value = parse(tokens);
  if (!Number.isFinite(value)) throw new Error('result is not a finite number');
  return value;
}

/* Extracts a computable arithmetic expression from a natural-language
   message, or null when the message is not primarily a calculation. Keeps
   the trigger tight so ordinary prose is never mangled into "math". */
export function extractExpression(message) {
  const text = String(message || '').trim();
  if (text.length > 200) return null;
  // Strip a leading "what is / calculate / compute / =" preamble.
  const cleaned = text
    .replace(/^\s*(what\s+is|whats|calculate|compute|evaluate|solve|=)\s*/i, '')
    .replace(/[?=]+\s*$/, '')
    .trim();
  if (!cleaned) return null;
  // Must be made only of arithmetic characters, digits, and known names,
  // and must contain at least one operator or function call.
  if (!/^[0-9a-zA-Z+\-*/%^().,\s]+$/.test(cleaned)) return null;
  if (!/[+\-*/%^]|\b(sqrt|sin|cos|tan|ln|log|exp|abs)\s*\(/i.test(cleaned)) return null;
  // Reject if it is clearly words (letters not forming known functions).
  const names = cleaned.match(/[a-zA-Z]+/g) || [];
  const known = new Set([...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS)]);
  if (names.some((n) => !known.has(n.toLowerCase()))) return null;
  return cleaned;
}

export const calculatorTool = Object.freeze({
  name: 'calculator',
  description: 'Evaluates a deterministic arithmetic expression '
    + '(+, -, *, /, %, ^, parentheses, and functions like sqrt, sin, ln).',
  permission: 'AUTHENTICATED_USER',
  schema: { expression: 'string' },
  validate(args) {
    return args && typeof args.expression === 'string' && args.expression.trim().length > 0;
  },
  run(args) {
    try {
      const value = evaluate(args.expression);
      return { ok: true, tool: 'calculator', expression: args.expression, value };
    } catch (error) {
      return { ok: false, tool: 'calculator', reason: error.message };
    }
  },
});
