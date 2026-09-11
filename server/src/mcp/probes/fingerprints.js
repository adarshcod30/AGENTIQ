/**
 * Database error fingerprints.
 *
 * The naive detector is:
 *
 *     typeof res.data === "string" && res.data.toLowerCase().includes("sql")
 *
 * Two failures in one line. It misses every JSON API (the overwhelming
 * majority of what this tool will be pointed at), because a parsed JSON
 * response is an object, not a string. And "includes('sql')" matches the word
 * in ordinary prose, so a body containing "no SQL knowledge required" becomes a
 * SQL-injection finding.
 *
 * docs/01_PRD.md F3 asks for real fingerprints: MySQL, PostgreSQL, SQLite,
 * MSSQL, Oracle, SQLSTATE, ODBC. Each pattern below matches error text a
 * database driver actually emits, not a word that happens to appear in English.
 */

/** Each entry names the engine so a finding can say WHICH database leaked. */
export const DB_FINGERPRINTS = [
  { engine: 'MySQL', pattern: /You have an error in your SQL syntax/i },
  { engine: 'MySQL', pattern: /\bmysql_fetch_(array|assoc|row|object)\b/i },
  { engine: 'MySQL', pattern: /\bWarning:\s+mysqli?_/i },
  { engine: 'MySQL', pattern: /Unknown column '[^']+' in 'field list'/i },

  { engine: 'PostgreSQL', pattern: /\bPG::(Syntax|Undefined|Invalid)\w*Error\b/i },
  { engine: 'PostgreSQL', pattern: /\bpg_(query|exec|connect)\(\)/i },
  { engine: 'PostgreSQL', pattern: /unterminated quoted string at or near/i },
  { engine: 'PostgreSQL', pattern: /syntax error at or near "/i },

  { engine: 'SQLite', pattern: /\bSQLITE_ERROR\b/i },
  { engine: 'SQLite', pattern: /\bsqlite3?[._](OperationalError|DatabaseError)\b/i },
  { engine: 'SQLite', pattern: /unrecognized token:/i },
  { engine: 'SQLite', pattern: /\bno such column\b/i },

  { engine: 'MSSQL', pattern: /Unclosed quotation mark after the character string/i },
  { engine: 'MSSQL', pattern: /\bMicrosoft OLE DB Provider for SQL Server\b/i },
  { engine: 'MSSQL', pattern: /\bIncorrect syntax near\b/i },
  { engine: 'MSSQL', pattern: /\bSystem\.Data\.SqlClient\.SqlException\b/i },

  { engine: 'Oracle', pattern: /\bORA-\d{5}\b/ },
  { engine: 'Oracle', pattern: /\bOracleException\b/i },
  { engine: 'Oracle', pattern: /quoted string not properly terminated/i },

  { engine: 'ODBC', pattern: /\bMicrosoft\]\[ODBC\b/i },
  { engine: 'ODBC', pattern: /\bODBC (SQL Server )?Driver\b/i },

  // SQLSTATE is engine-agnostic and appears in PDO, JDBC and ODBC errors.
  { engine: 'SQLSTATE', pattern: /\bSQLSTATE\[[0-9A-Z]{5}\]/i },

  { engine: 'Generic', pattern: /\bSQLException\b/ },
  { engine: 'Generic', pattern: /\bjava\.sql\.SQLException\b/ },
  { engine: 'Generic', pattern: /\bpsycopg2\.\w+Error\b/i },
];

/**
 * Flattens any response body to searchable text.
 *
 * A driver error nested at `{ error: { detail: "SQLSTATE[42000] ..." } }` is
 * invisible to a string check, so the whole structure is serialised before
 * matching.
 */
export function bodyToText(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * Looks for a database error signature.
 *
 * @returns {{ found: boolean, engine: string|null, excerpt: string|null }}
 */
export function findDbError(body) {
  const text = bodyToText(body);
  if (!text) return { found: false, engine: null, excerpt: null };

  for (const { engine, pattern } of DB_FINGERPRINTS) {
    const match = text.match(pattern);
    if (match) {
      // A short excerpt around the hit: enough to be evidence, short enough
      // that a huge body does not end up in the finding.
      const at = match.index ?? 0;
      const excerpt = text.slice(Math.max(0, at - 40), at + 160).trim();
      return { found: true, engine, excerpt };
    }
  }
  return { found: false, engine: null, excerpt: null };
}

/**
 * SQL injection payloads. All read-only.
 *
 * docs/01_PRD.md F3 is a hard ethical boundary: detection only, never
 * exploitation. Nothing here modifies data: no DROP, no DELETE, no UPDATE,
 * no stacked statements. These provoke a parser error or a boolean difference
 * and nothing else.
 */
export const SQLI_PAYLOADS = [
  { value: "'", label: 'single quote', intent: 'provoke a parser error' },
  { value: '"', label: 'double quote', intent: 'provoke a parser error' },
  { value: "' OR '1'='1", label: 'always-true string', intent: 'boolean difference' },
  { value: ' OR 1=1--', label: 'always-true numeric', intent: 'boolean difference' },
  { value: "1' AND '1'='2", label: 'always-false', intent: 'boolean difference' },
];

/** Assertion that the payload set stays non-destructive. Used by the tests. */
export const DESTRUCTIVE = /\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER|EXEC|SHUTDOWN)\b/i;

/**
 * Reflected-XSS payloads, each with a unique marker so a reflection can be
 * attributed to THIS probe rather than to content that happened to be present.
 */
export function xssPayloads(nonce) {
  return [
    { value: `<script>agentiq${nonce}</script>`, label: 'script tag' },
    { value: `"><img src=x onerror=agentiq${nonce}>`, label: 'attribute break-out' },
    { value: `'><svg onload=agentiq${nonce}>`, label: 'svg handler' },
  ];
}

/** True when the payload came back unescaped: the actual XSS signal. */
export function isReflectedUnescaped(body, payload) {
  const text = bodyToText(body);
  if (!text.includes(payload)) return false;
  // If the dangerous characters were escaped, the literal payload would not
  // appear verbatim. Its presence means no escaping happened.
  return true;
}

/** Content types where reflected markup is actually dangerous. */
export function isHtmlish(contentType) {
  return /text\/html|application\/xhtml/i.test(String(contentType ?? ''));
}
