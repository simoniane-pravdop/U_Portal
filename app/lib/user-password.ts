import type { PortalUser } from "../types";

export function mayResetPassword(actor: Pick<PortalUser, "role">, target: Pick<PortalUser, "role">) {
  // Resetting a peer administrator's password does not grant role-management rights.
  return ["owner", "admin"].includes(actor.role) && target.role !== "owner";
}

export function generatePassword() {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%_-+"];
  const alphabet = groups.join("");
  const values = crypto.getRandomValues(new Uint32Array(20));
  const characters = groups.map((group, index) => group[values[index] % group.length]);
  for (let index = groups.length; index < values.length; index += 1) characters.push(alphabet[values[index] % alphabet.length]);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const target = values[index] % (index + 1);
    [characters[index], characters[target]] = [characters[target], characters[index]];
  }
  return characters.join("");
}
