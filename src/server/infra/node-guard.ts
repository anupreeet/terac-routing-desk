// Fail with a readable message instead of a stack trace when Node is too old for node:sqlite.
export function checkNode(): void {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > 22 || (major === 22 && minor >= 13);
  if (!ok) {
    console.error(`Terac Routing Desk needs Node 22.13 or newer (for the built-in node:sqlite). You have ${process.versions.node}. Try: nvm use`);
    process.exit(1);
  }
}
