/**
 * Worker entry for one plugin sandbox. Vite bundles this file as a module
 * worker (see plugin-host.ts); all logic lives in sandbox-runtime.ts so tests
 * can install the same runtime on a fake scope.
 */

import { installSandbox } from "./sandbox-runtime";
import type { SandboxScope } from "./sandbox-runtime";

installSandbox(self as unknown as SandboxScope);
