/* oxlint-disable effecttsgo/prefer-effect-array, effecttsgo/strict-boolean-expressions -- #134 (the JWT row) wrote this file before main moved to the Effect 4.1 lint rules. #134 brings it to those rules when it merges main, so row 7 leaves its code as #134 has it rather than rewrite it twice. */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Web Crypto generates no primes, and a 16,384-bit key from it takes minutes.
import { checkPrimeSync, generatePrimeSync, randomBytes } from "node:crypto";

const e = 65537n;

const toBytes = (value: bigint, length: number) =>
  Uint8Array.from({ length }, (_, index) =>
    Number((value >> BigInt(8 * (length - 1 - index))) & 0xffn),
  );

const fromBytes = (bytes: Uint8Array) =>
  bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);

const modPow = (base: bigint, exponent: bigint, modulus: bigint) => {
  let result = 1n;
  let square = base % modulus;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = (result * square) % modulus;
    square = (square * square) % modulus;
  }
  return result;
};

const inverse = (value: bigint, modulus: bigint) => {
  let [r0, r1, t0, t1] = [modulus, value % modulus, 0n, 1n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1, t0, t1] = [r1, r0 - q * r1, t1, t0 - q * t1];
  }
  return ((t0 % modulus) + modulus) % modulus;
};

const usable = (prime: bigint) => (prime - 1n) % e !== 0n;

/**
 * A prime between `lo` and `hi`, drawn from the host.
 */
const primeBetween = (lo: bigint, hi: bigint) => {
  const width = hi - lo;
  const bytes = Math.ceil(width.toString(2).length / 8) + 8;
  for (;;) {
    const candidate = (lo + (fromBytes(randomBytes(bytes)) % width)) | 1n;
    if (candidate <= hi && usable(candidate) && checkPrimeSync(candidate)) {
      return candidate;
    }
  }
};

// SHA-256's DigestInfo prefix, RFC 8017 section 9.2, note 1.
const sha256DigestInfo = Uint8Array.from([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
  0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
]);

/**
 * An RSA public key of exactly `bits` bits, as a JWK, and an RS256 signer for
 * it. Its modulus is a product of 512-bit primes and one sized to make it
 * exact, so a key past the binary's 8,192-bit limit and its signature take well
 * under a second, not the minutes Web Crypto needs. A public key's factors are
 * never checked, so Web Crypto verifies what it signs.
 */
export const oversizedRsa = (bits: number) => {
  const primes = Array.from({ length: Math.floor(bits / 512) - 1 }, () => {
    for (;;) {
      const prime = generatePrimeSync(512, { bigint: true });
      if (usable(prime)) return prime;
    }
  });
  const partial = primes.reduce((product, prime) => product * prime, 1n);
  const last = primeBetween(
    (1n << BigInt(bits - 1)) / partial + 1n,
    ((1n << BigInt(bits)) - 1n) / partial,
  );
  const factors = [...primes, last];
  const n = partial * last;
  // The signature by the CRT, one small exponentiation per factor.
  const parts = factors.map((prime) => {
    const rest = n / prime;
    return {
      prime,
      exponent: inverse(e, prime - 1n),
      weight: rest * inverse(rest % prime, prime),
    };
  });
  const root = (value: bigint) =>
    parts.reduce(
      (sum, { prime, exponent, weight }) =>
        sum + modPow(value % prime, exponent, prime) * weight,
      0n,
    ) % n;
  const length = bits / 8;
  return {
    bits: n.toString(2).length,
    jwk: {
      kty: "RSA",
      n: Buffer.from(toBytes(n, length)).toString("base64url"),
      e: "AQAB",
    },
    sign: (message: Uint8Array) =>
      crypto.subtle.digest("SHA-256", message as BufferSource).then((hash) => {
        const padding = length - 3 - sha256DigestInfo.length - 32;
        const encoded = fromBytes(
          Uint8Array.from([
            0x00,
            0x01,
            ...Array.from({ length: padding }, () => 0xff),
            0x00,
            ...sha256DigestInfo,
            ...new Uint8Array(hash),
          ]),
        );
        return toBytes(root(encoded), length);
      }),
  };
};
