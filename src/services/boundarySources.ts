export interface ShapeSource {
  layer: string;
  keyField: string;
  nameField?: string;
  where?: string;
  entity: string;
  body: string;
  title: string;
  research: 'congress' | 'openStates' | 'official';
  urls: string[];
  effectiveDate?: string;
  expirationDate?: string;
}
const city = 'https://services2.arcgis.com/rwnOSbfKSwyTBcwN/arcgis/rest/services';
const county = 'https://services3.arcgis.com/zqe2kwz79KUqUvxC/arcgis/rest/services';
const census = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';
export const DALLAS_CITY_LAYER = `${city}/CityLimits/FeatureServer/0`;
export const shapeSources: Record<string, ShapeSource> = {
  congress119: { layer: `${census}/Legislative/MapServer/4`, keyField: 'CD119', where: "STATE = '48'", entity: 'United States', body: 'House of Representatives', title: 'U.S. Representative', research: 'congress', urls: ['https://www.house.gov/representatives'], effectiveDate: '2025-01-03', expirationDate: '2027-01-03' },
  congress120: { layer: `${census}/Legislative/MapServer/0`, keyField: 'CD120', where: "STATE = '48'", entity: 'United States', body: 'House of Representatives', title: 'U.S. Representative', research: 'congress', urls: ['https://www.house.gov/representatives'], effectiveDate: '2027-01-03', expirationDate: '2029-01-03' },
  texasSenate: { layer: `${census}/Legislative/MapServer/5`, keyField: 'SLDU', where: "STATE = '48'", entity: 'State of Texas', body: 'Senate', title: 'State Senator', research: 'openStates', urls: ['https://senate.texas.gov/members.php'] },
  texasHouse: { layer: `${census}/Legislative/MapServer/6`, keyField: 'SLDL', where: "STATE = '48'", entity: 'State of Texas', body: 'House of Representatives', title: 'State Representative', research: 'openStates', urls: ['https://house.texas.gov/members'] },
  sboe: { layer: `${county}/SBOE/FeatureServer/0`, keyField: 'District', entity: 'State of Texas', body: 'State Board of Education', title: 'Board member', research: 'official', urls: ['https://sboe.texas.gov/state-board-of-education/sboe-board-members/sboe-members'] },
  countyJudge: { layer: `${census}/State_County/MapServer/1`, keyField: 'GEOID', where: "STATE = '48' AND COUNTY = '113'", entity: 'Dallas County', body: 'Commissioners Court', title: 'County Judge', research: 'official', urls: ['https://www.dallascounty.org/government/comcrt/'] },
  commissioners: { layer: `${county}/COMM/FeatureServer/0`, keyField: 'DISTRICT', entity: 'Dallas County', body: 'Commissioners Court', title: 'Commissioner', research: 'official', urls: ['https://www.dallascounty.org/government/comcrt/'] },
  council: { layer: `${city}/CouncilAreas/FeatureServer/0`, keyField: 'DISTRICT', entity: 'City of Dallas', body: 'City Council', title: 'Council member', research: 'official', urls: ['https://dallascityhall.com/government/Pages/city-council.aspx'] },
  cpc: { layer: `${city}/CouncilAreas/FeatureServer/0`, keyField: 'DISTRICT', entity: 'City of Dallas', body: 'City Plan Commission', title: 'Commissioner', research: 'official', urls: ['https://dallascityhall.com/government/meetings/Pages/city-plan-commission.aspx'] },
  parks: { layer: `${city}/CouncilAreas/FeatureServer/0`, keyField: 'DISTRICT', entity: 'City of Dallas', body: 'Park and Recreation Board', title: 'Board member', research: 'official', urls: ['https://www.dallasparks.org/107/Park-and-Recreation-Board'] },
  disd: { layer: 'https://services.arcgis.com/RfrtTbYxQ8YIhjWT/arcgis/rest/services/DISD_Trustee_SMD_Adopted_Dec_16_2021/FeatureServer/0', keyField: 'PLAN_5', entity: 'Dallas Independent School District', body: 'Board of Trustees', title: 'Trustee', research: 'official', urls: ['https://www.dallasisd.org/board-of-trustees/board-members'] },
  pids: { layer: `${city}/EconomicDevelopment/FeatureServer/2`, keyField: 'ID', nameField: 'Name', where: "Name NOT LIKE '%Expired%'", entity: 'Public Improvement District', body: 'Management', title: 'Manager', research: 'official', urls: ['https://www.dallasecodev.org/245/Public-Improvement-Districts'] },
  neighborhoods: { layer: `${city}/NeighborhoodAssociations/FeatureServer/0`, keyField: 'OBJECTID', nameField: 'ASSO_NAME', where: "Asso_Type = 'NA' AND Status = 'Confirmed'", entity: 'Neighborhood association', body: 'Board', title: 'President', research: 'official', urls: ['https://dallascityhall.com/departments/Pages/default.aspx'] },
  hoas: { layer: `${city}/NeighborhoodAssociations/FeatureServer/0`, keyField: 'OBJECTID', nameField: 'ASSO_NAME', where: "Asso_Type = 'HOA'", entity: 'Homeowners association', body: 'Board', title: 'President', research: 'official', urls: ['https://www.hoa.texas.gov/'] },
};
export const officialResearchHosts = new Set([
  'dallascityhall.com', 'www.dallascityhall.com', 'www.dallascounty.org', 'dallascounty.org',
  'www.dallasparks.org', 'dallasparks.org', 'www.dallasisd.org', 'dallasisd.org',
  'tea.texas.gov', 'sboe.texas.gov', 'senate.texas.gov', 'house.texas.gov', 'www.hoa.texas.gov',
  'www.dallasecodev.org', 'dallasecodev.org', 'www.house.gov', 'www.senate.gov',
]);
