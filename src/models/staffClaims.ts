export type CustomClaims = Record<string, unknown>;

export function hasRecognizedStaff(claims: CustomClaims): boolean {
  return claims.staff === true || claims.role === 'staff' || claims.roles === 'staff'
    || (Array.isArray(claims.roles) && claims.roles.includes('staff'));
}

/** Remove only legacy staff representations, leaving every other claim/role intact. */
export function withStaffClaim(claims: CustomClaims, staff: boolean): CustomClaims {
  const result = { ...claims };
  if (result.role === 'staff') delete result.role;
  if (result.roles === 'staff') delete result.roles;
  else if (Array.isArray(result.roles)) result.roles = result.roles.filter(role => role !== 'staff');
  if (staff) result.staff = true;
  else delete result.staff;
  return result;
}
