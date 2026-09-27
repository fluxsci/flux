export interface ProcessInvocation { executable: string; argv?: string[]; cwd: string; envDelta?: NodeJS.ProcessEnv }
export interface ProcessOptions { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; onOutput?: (stream: 'stdout'|'stderr', bytes: Buffer) => void; stdio?: 'inherit'; killGraceMs?: number }
export interface ProcessResult { status: 'exited'|'signal'|'spawn-error'|'timeout'|'cancelled'|'output-error'; code: number; signal: string|null; stdout: string; stderr: string; truncated: {stdout:number;stderr:number} }
export function runProcess(invocation: ProcessInvocation, options?: ProcessOptions): Promise<ProcessResult>;
