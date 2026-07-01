import * as NodeOS from "node:os";

const T3CODE_TEMP_HOME_PATTERN = /^\/(?:private\/)?tmp\/t3code-home(?:\/|$)/;

function shouldUseOsAccountHome(home: string | undefined): boolean {
  return typeof home === "string" && T3CODE_TEMP_HOME_PATTERN.test(home);
}

export function resolveLocalUserHome(baseEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!shouldUseOsAccountHome(baseEnv.HOME)) {
    return baseEnv.HOME;
  }

  return NodeOS.userInfo().homedir || baseEnv.HOME;
}

export function withLocalUserHome(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const localHome = resolveLocalUserHome(baseEnv);
  if (!localHome || localHome === baseEnv.HOME) {
    return baseEnv;
  }

  return {
    ...baseEnv,
    HOME: localHome,
  };
}
