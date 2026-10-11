// Short, checked write-ups for the famous rocks on the home screen. Live numbers (size, orbit, next pass) come from JPL;
// what is written here is the story and the measurements that do not change.
export interface FamousInfo {
  tagline: string;
  why: string;
  facts: [string, string][];
}

export const FAMOUS: Record<string, FamousInfo> = {
  '99942': {
    tagline: 'The asteroid that scared the world',
    why: 'In 2004 Apophis briefly had the highest impact rating ever given to an asteroid. More observations ruled out a hit, but on 13 April 2029 it will fly past closer than many satellites, close enough to see with the naked eye.',
    facts: [
      ['Discovered', 'June 2004, Kitt Peak, Arizona'],
      ['Spin', 'Tumbles, about 30 hours'],
      ['Closest pass', '13 April 2029, about 32,000 km up'],
      ['Highest scare', 'Level 4 on the 0 to 10 Torino scale'],
      ['Visited by', 'NASA OSIRIS-APEX, 2029'],
    ],
  },
  '101955': {
    tagline: 'The rock we brought home',
    why: 'NASA sent OSIRIS-REx to Bennu, scooped up pieces of it and dropped them to Earth in 2023. It is a loose pile of rubble shaped like a spinning top, and one of the most closely watched hazardous asteroids.',
    facts: [
      ['Discovered', 'September 1999, LINEAR survey'],
      ['Spin', 'Once every 4.3 hours'],
      ['Shape', 'Spinning top, a pile of rubble'],
      ['Sample returned', 'About 120 g, September 2023'],
      ['Impact chance', 'Around 1 in 2,700 over 300 years'],
    ],
  },
  '65803': {
    tagline: 'The asteroid we actually pushed',
    why: 'Didymos is a double asteroid. In 2022 NASA crashed the DART spacecraft into its small moon, Dimorphos, and made the moon’s orbit 33 minutes shorter. It was the first time humans changed the motion of a space object.',
    facts: [
      ['Discovered', 'April 1996, Spacewatch'],
      ['Moon', 'Dimorphos, about 160 m wide'],
      ['DART hit', '26 September 2022'],
      ['Orbit change', '11 h 55 m to 11 h 23 m'],
      ['Follow-up', 'ESA Hera mission'],
    ],
  },
  '2024 YR4': {
    tagline: 'The newest scare',
    why: 'Found in December 2024, it briefly had the highest impact chance ever recorded for an asteroid this big: about 1 in 32 for 2032. New observations soon showed Earth was safe.',
    facts: [
      ['Discovered', 'December 2024, ATLAS, Chile'],
      ['Peak chance', 'About 3% for 22 December 2032'],
      ['Highest scare', 'Level 3 on the Torino scale'],
      ['Earth impact', 'Ruled out in February 2025'],
      ['Still open', 'A small chance of hitting the Moon'],
    ],
  },
  '2011 AG5': {
    tagline: 'A near-miss on paper',
    why: 'A 140 m rock that was once thought to have a 1 in 625 chance of hitting in 2040. The risk depended on it passing through a keyhole only 365 km wide. Later observations showed it would miss.',
    facts: [
      ['Discovered', 'January 2011, Mount Lemmon'],
      ['Feared date', '5 February 2040'],
      ['Highest scare', 'Level 1 on the Torino scale'],
      ['The catch', 'A keyhole 365 km wide in 2023'],
      ['Outcome', 'Later observations ruled it out'],
    ],
  },
  '2023 DW': {
    tagline: 'The Valentine’s Day asteroid',
    why: 'Spotted in early 2023, this 50 m rock had a small chance of hitting on Valentine’s Day 2046. Within weeks, new measurements cut the odds to about 1 in 3,600. It shows how early scares usually fade.',
    facts: [
      ['Discovered', 'Early 2023'],
      ['Feared date', '14 February 2046'],
      ['First odds', 'About 1 in 560'],
      ['Odds a month later', 'About 1 in 3,600'],
      ['Highest scare', 'Level 1 on the Torino scale'],
    ],
  },
  '162173': {
    tagline: 'The diamond-shaped time capsule',
    why: 'Japan’s Hayabusa2 spent a year at Ryugu, fired a copper bullet into it to dig up fresh rock, and returned samples to Earth in 2020. Its carbon-rich dust holds clues about where Earth’s water came from.',
    facts: [
      ['Discovered', 'May 1999, LINEAR survey'],
      ['Spin', 'Once every 7.6 hours'],
      ['Shape', 'Spinning top, like a diamond'],
      ['Sample returned', 'About 5 g, December 2020'],
      ['Made of', 'Dark, carbon-rich rock'],
    ],
  },
  '1950 DA': {
    tagline: 'The fastest-spinning giant',
    why: 'It spins once every 2.1 hours, so fast that it is held together only by the weak stickiness between its grains. Over a very long time its path could meet Earth: a tiny chance of a hit on 16 March 2880.',
    facts: [
      ['Discovered', 'February 1950, Lick Observatory'],
      ['Spin', 'Once every 2.12 hours'],
      ['Lost and found', 'Missing for 50 years'],
      ['Possible hit', '16 March 2880'],
      ['Odds', 'About 1 in 8,000 or smaller'],
    ],
  },
};
