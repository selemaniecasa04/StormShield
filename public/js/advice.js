// Preparedness assistant: turns hazards into "what is happening / why it matters / what to do".
// Guidance is general safety advice and never replaces instructions from local authorities.

const A = {
  storm: {
    why: 'Lightning can strike up to about 15 km from a storm, well before heavy rain arrives.',
    do: {
      low: ['Keep an eye on the sky and plan where you would shelter.'],
      moderate: ['Plan outdoor activity so you can reach a solid building or a hard-top vehicle quickly.', 'If you hear thunder, go indoors and stay there until 30 minutes after the last thunder.'],
      high: ['Move into a substantial enclosed building or a hard-top vehicle now.', 'Avoid open fields, hilltops, isolated trees, water and metal fences.', 'Stay off corded phones and away from plumbing during the storm.'],
      severe: ['Get inside a substantial building immediately.', 'Stay away from windows and doors.', 'Follow official severe-weather guidance.'],
    },
    driving: ['If storms reach you while driving, stay in the vehicle with windows closed rather than sheltering under a tree.'],
  },
  hail: {
    why: 'Hail can injure people and animals, break windows and damage vehicles and crops.',
    do: {
      low: ['Know where you can park under cover if hail starts.'],
      moderate: ['Park vehicles under cover if you can.', 'Bring pets and loose items inside.'],
      high: ['Go indoors and keep away from windows and skylights.', 'If driving, slow down and stop somewhere safe and covered, not under a bridge where you block traffic.'],
      severe: ['Shelter indoors in an interior room away from glass.', 'Do not go outside to protect property during the storm.'],
    },
  },
  flood: {
    why: 'Fast-moving water 15 cm deep can knock you over, and 30 cm can float a car. Flooded roads may hide washed-out surfaces.',
    do: {
      low: ['Avoid low-lying paths and stormwater channels if rain continues.'],
      moderate: ['Avoid flooded roads, bridges over fast water and low-water crossings.', 'Move valuables and electrical items off the floor if your home floods easily.', 'Plan a route to higher ground.'],
      high: ['Do not walk, cycle or drive through flood water.', 'Consider a safer alternative route that avoids river crossings.', 'Be ready to move to higher ground. Follow official evacuation instructions if issued.'],
      severe: ['Move to higher ground now if you are in a low-lying area or near a river.', 'Never enter flood water. Turn around if a road is covered.', 'Follow official evacuation instructions and call emergency services if you are trapped.'],
    },
    driving: ['Turn around if water covers the road. You cannot judge depth or current from a vehicle.'],
  },
  wind: {
    why: 'Strong gusts can bring down trees, branches and power lines, and push high-sided vehicles off course.',
    do: {
      low: ['Secure light outdoor items such as bins and chairs.'],
      moderate: ['Secure loose items outdoors.', 'Avoid parking under trees.'],
      high: ['Stay indoors away from windows where possible.', 'Keep well clear of fallen power lines and report them.', 'Delay travel in high-sided vehicles, on motorbikes or bicycles.'],
      severe: ['Shelter in an interior room of a strong building.', 'Do not travel unless necessary.', 'Stay at least 10 m from fallen power lines.'],
    },
    driving: ['Grip the wheel firmly and slow down, especially on bridges and open roads.'],
  },
  heat: {
    why: 'High heat strains the body and can cause heat exhaustion or heatstroke, especially for older people, young children and outdoor workers.',
    do: {
      low: ['Drink water regularly and wear light clothing.'],
      moderate: ['Reduce strenuous outdoor activity in the hottest part of the day.', 'Drink water regularly, even if you do not feel thirsty.', 'Check on older neighbours and anyone living alone.'],
      high: ['Avoid strenuous outdoor activity between 11:00 and 16:00.', 'Seek shade or a cool indoor space.', 'Know the signs of heatstroke: confusion, hot dry skin, fainting. Call emergency services if you see them.'],
      severe: ['Stay in the coolest place you can reach.', 'Never leave children or pets in a parked vehicle.', 'Seek medical help for anyone with heatstroke symptoms.'],
    },
  },
  cold: {
    why: 'Very low feels-like temperatures can cause hypothermia and frostbite quickly.',
    do: { low: ['Dress in layers.'], moderate: ['Limit time outdoors and cover exposed skin.'], high: ['Stay indoors where possible and keep dry.', 'Check on vulnerable neighbours.'], severe: ['Avoid going outside.', 'Use heaters safely and never use fuel-burning devices indoors without ventilation.'] },
  },
  uv: {
    why: 'At this UV level unprotected skin can burn in under 15 minutes.',
    do: { low: ['Use sunscreen and a hat outdoors.'], moderate: ['Seek shade around midday, use SPF 30+ sunscreen, a hat and sunglasses.'], high: ['Limit midday sun exposure and cover up.'], severe: ['Avoid direct sun around midday.'] },
  },
  air: {
    why: 'Fine particles and dust irritate lungs and can worsen asthma and heart conditions.',
    do: {
      low: ['Sensitive people should reduce long outdoor exertion.'],
      moderate: ['Reduce strenuous outdoor activity.', 'People with asthma or heart conditions should keep medication close.'],
      high: ['Stay indoors with windows closed where possible.', 'Wear a well-fitted N95/FFP2 mask if you must be outside.'],
      severe: ['Stay indoors and avoid outdoor exertion.', 'Seek medical help for breathing difficulty.'],
    },
  },
  visibility: {
    why: 'Low visibility greatly increases the risk of road collisions.',
    do: { low: ['Use dipped headlights.'], moderate: ['Slow down and increase following distance.'], high: ['Delay travel if you can.', 'Use dipped headlights and fog lights. Do not use high beams.'], severe: ['Avoid driving until visibility improves.'] },
  },
};

const sevKey = (lvl) => (lvl === 'none' ? 'low' : lvl);

export function adviceFor(h, activity) {
  if (h.official) {
    const o = h.official;
    return {
      what: o.headline || o.event, why: o.description ? o.description.slice(0, 600) + (o.description.length > 600 ? '…' : '') : 'Issued by an official authority for your area.',
      do: o.instruction ? o.instruction.split(/\n+/).filter(Boolean).slice(0, 5) : ['Follow the instructions issued by the authority named below.'],
      official: true,
    };
  }
  const t = A[h.id] || A[h.layer] || { why: '', do: { low: [] } };
  const steps = [...(t.do[sevKey(h.level)] || t.do.low || [])];
  if (activity === 'driving' && t.driving) steps.unshift(...t.driving);
  return { what: h.detail, why: t.why, do: steps };
}

export function headline(assessment) {
  if (!assessment || assessment.level === 'UNKNOWN') return 'Risk cannot be assessed right now';
  const top = assessment.hazards[0];
  switch (assessment.level) {
    case 'EMERGENCY': return `Take protective action now: ${top?.label.toLowerCase()}`;
    case 'WARNING': return `Hazardous conditions: ${top?.label.toLowerCase()}`;
    case 'WATCH': return `Conditions developing: ${top?.label.toLowerCase()}`;
    default: return top ? `No significant threat detected. Minor: ${top.label.toLowerCase()}` : 'No significant threat detected in the available data';
  }
}

export const LEVEL_TEXT = {
  SAFE: 'No significant immediate threat was detected in the available information. This is not a guarantee of safety.',
  WATCH: 'Conditions are developing and need your attention.',
  WARNING: 'Hazardous conditions are likely or you are significantly exposed.',
  EMERGENCY: 'A credible, immediate threat needs urgent protective action. Follow local authorities.',
  UNKNOWN: 'Not enough data to assess your risk.',
};
