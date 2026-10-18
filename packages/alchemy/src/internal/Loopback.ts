import * as Option from "effect/Option";

/**
 * The origin of a local backend port. Local backends bind only loopback.
 */
export const origin = (port: number) => `http://127.0.0.1:${port}`;

const isPort = (port: number) => port >= 1 && port <= 65535;

/**
 * Whether `url` is exactly a loopback origin such as `http://127.0.0.1:3210`.
 */
export const isOrigin = (url: string) => {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(url);
  return match !== null && isPort(Number(match[1]));
};

export interface PortRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Parse an inclusive `from-to` range of usable ports, such as `3300-3399`.
 */
export const parsePortRange = (value: string): Option.Option<PortRange> => {
  const match = /^([0-9]{1,5})-([0-9]{1,5})$/.exec(value);
  if (match === null) return Option.none();
  const from = Number(match[1]);
  const to = Number(match[2]);
  return isPort(from) && isPort(to) && from <= to
    ? Option.some({ from, to })
    : Option.none();
};
