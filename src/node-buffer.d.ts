// Provided at runtime by `nodejs_compat`. The project leaves @types/node out of
// its types, so only what teleproto's uploads need is declared.
declare module "node:buffer" {
  export const Buffer: { from(bytes: Uint8Array): Uint8Array };
}
