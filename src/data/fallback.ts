import type { Detail } from '../api';

// Cached copies of JPL SBDB values, used only when the live API cannot be reached.
const el = (a: number, e: number, i: number, om: number, w: number, ma: number) => ({ a, e, i, om, w, ma });

export const FALLBACK_CATALOG: Detail[] = [
  { des: '99942', name: '99942 Apophis (2004 MN4)', shortName: '99942 Apophis', orbitClass: 'Aten', pha: true, H: 19.09, diameterM: 340, diameterMeasured: true, elements: el(0.9224, 0.1914, 3.34, 203.9, 126.7, 175), approaches: [{ date: '2029-Apr-13 21:46', distKm: 38000, vRel: 7.42, vInf: 5.84 }], blurb: 'Passes about 32,000 km above Earth on 13 April 2029, closer than geostationary satellites.', source: 'cached' },
  { des: '101955', name: '101955 Bennu (1999 RQ36)', shortName: '101955 Bennu', orbitClass: 'Apollo', pha: true, H: 20.19, diameterM: 490, diameterMeasured: true, elements: el(1.1264, 0.2037, 6.035, 2.06, 66.22, 101), approaches: [], blurb: 'Sampled by OSIRIS-REx; among the most hazardous known asteroids over the next two centuries.', source: 'cached' },
  { des: '65803', name: '65803 Didymos (1996 GT)', shortName: '65803 Didymos', orbitClass: 'Apollo', pha: true, H: 18.11, diameterM: 780, diameterMeasured: true, elements: el(1.6444, 0.3838, 3.41, 73.2, 319.3, 261), approaches: [], blurb: 'The DART mission redirected its moonlet Dimorphos in 2022.', source: 'cached' },
  { des: '2024 YR4', name: '(2024 YR4)', shortName: '2024 YR4', orbitClass: 'Apollo', pha: true, H: 23.93, diameterM: 60, diameterMeasured: false, elements: el(2.52, 0.661, 3.41, 271.4, 134.4, 139), approaches: [], blurb: 'Discovered December 2024; briefly carried the highest impact probability ever recorded for an object this size.', source: 'cached' },
  { des: '2011 AG5', name: '367789 (2011 AG5)', shortName: '367789 (2011 AG5)', orbitClass: 'Apollo', pha: true, H: 21.77, diameterM: 140, diameterMeasured: false, elements: el(1.42, 0.388, 3.69, 136, 54, 324), approaches: [], blurb: 'A 140 m-class object once on the risk list; later observations ruled out an impact.', source: 'cached' },
  { des: '2023 DW', name: '(2023 DW)', shortName: '2023 DW', orbitClass: 'Aten', pha: false, H: 24.32, diameterM: 50, diameterMeasured: false, elements: el(0.82, 0.396, 5.8, 326, 40.5, 273), approaches: [], blurb: 'A 50 m-class object that briefly reached Torino scale 1 in 2023.', source: 'cached' },
  { des: '162173', name: '162173 Ryugu (1999 JU3)', shortName: '162173 Ryugu', orbitClass: 'Apollo', pha: true, H: 19.25, diameterM: 1000, diameterMeasured: true, elements: el(1.1896, 0.1902, 5.88, 251.6, 211.4, 40), approaches: [], blurb: 'Visited and sampled by Hayabusa2.', source: 'cached' },
  { des: '1950 DA', name: '29075 (1950 DA)', shortName: '29075 (1950 DA)', orbitClass: 'Apollo', pha: true, H: 17.28, diameterM: 1300, diameterMeasured: true, elements: el(1.7, 0.508, 12.2, 357, 225, 130), approaches: [], blurb: 'A kilometre-scale object with a small, long-term impact chance in 2880.', source: 'cached' },
];
