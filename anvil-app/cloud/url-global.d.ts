// Minimal ambient URL surface used by discovery. Every supported runtime
// (browsers and modern Node) provides this globally; it is declared here so
// the contract typechecks without DOM or Node type libraries and without
// importing any runtime module.
declare class URL {
  constructor(url: string | URL, base?: string | URL);
  href: string;
  origin: string;
  pathname: string;
  protocol: string;
  hostname: string;
  username: string;
  password: string;
}
