// Loaded FIRST (before any crawlee import) to set env that changes Crawlee's
// memory-info behaviour. Lives in its own module because ES `import` statements
// are hoisted — code placed above an import in the same file would NOT run first,
// but a separately-imported module's top-level code runs in import order.
//
// Why: Crawlee spawns the `ps` command for memory snapshots only when it detects
// NEITHER AWS Lambda NOR Docker. Easypanel containers can fail Crawlee's
// isDocker() check (missing /.dockerenv), so it falls back to `ps` — which throws
// "spawn ps ENOENT" on minimal images and kills every job. Presenting as Lambda
// makes Crawlee read /proc/meminfo + process.memoryUsage() instead, never `ps`.
if (!process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE) {
  process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = process.env.MEMORY_MBYTES || '2048'
}
