/** Version-controlled official source registry. Extend only with reviewed City of Dallas pages. */
export const recommendableSources = [
  {
    key: 'dallas-master-bike-plan',
    url: 'https://dallascityhall.com/departments/transportation/bikeway/Pages/Bike-Plan-Update.aspx',
    description: 'Identify any currently open Dallas Master Bike Plan public-input opportunity and how residents can submit it.',
    boundaryQuery: { entity: 'City of Dallas', body: 'City Council' },
  },
] as const;
