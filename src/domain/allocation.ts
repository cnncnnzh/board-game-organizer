/** Pure allocation logic migrated from board_game_reg, independent of transport/storage. */
export interface AllocationGame {
  id: string;
  name: string;
  capacity: number;
  attendees: ReadonlyArray<{ participantId: string }>;
}

export interface AllocationRegistration {
  participantId: string;
  status: string;
  secondaryGameId?: string | null;
}

export interface Assignment {
  participantId: string;
  gameId: string;
  // Shared by all waitlist assignments so public results do not disclose preferences.
  reason: 'balanced';
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (const char of String(input)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededRandom(seed: string): () => number {
  let state = hashSeed(seed) || 1;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

/** Callers supply a stable database order. Existing attendees are never moved. */
export function allocateWaitlist({ games, registrations, seed }: {
  games: readonly AllocationGame[];
  registrations: readonly AllocationRegistration[];
  seed: string;
}) {
  const random = seededRandom(seed);
  const gameState = games.map((game) => ({
    id: game.id,
    name: game.name,
    capacity: game.capacity,
    attendeeParticipantIds: game.attendees.map((member) => member.participantId),
  }));
  const candidates = registrations.filter((registration) => registration.status === 'waitlist');
  const openSeatCount = gameState.reduce(
    (sum, game) => sum + Math.max(0, game.capacity - game.attendeeParticipantIds.length), 0,
  );
  const assignments: Assignment[] = [];
  const assignedParticipants = new Set<string>();
  // Complete every table's second-choice round before balancing any remaining players.
  for (const game of gameState) {
    const available = Math.max(0, game.capacity - game.attendeeParticipantIds.length);
    if (!available) continue;
    const interested = candidates.filter((registration) => registration.secondaryGameId === game.id);
    const selected = interested.length > available ? shuffle(interested, random).slice(0, available) : interested;
    for (const registration of selected) {
      game.attendeeParticipantIds.push(registration.participantId);
      assignedParticipants.add(registration.participantId);
      assignments.push({ participantId: registration.participantId, gameId: game.id, reason: 'balanced' });
    }
  }
  const shuffledCandidates = shuffle(candidates.filter((registration) => !assignedParticipants.has(registration.participantId)), random);
  const selectedCount = Math.min(shuffledCandidates.length, openSeatCount - assignments.length);
  for (let index = 0; index < selectedCount; index += 1) {
    const registration = shuffledCandidates[index]!;
    const availableGames = gameState.filter((game) => game.attendeeParticipantIds.length < game.capacity);
    const fewestAttendees = Math.min(...availableGames.map((game) => game.attendeeParticipantIds.length));
    const smallestGames = availableGames.filter((game) => game.attendeeParticipantIds.length === fewestAttendees);
    const game = smallestGames[Math.floor(random() * smallestGames.length)]!;
    game.attendeeParticipantIds.push(registration.participantId);
    assignments.push({ participantId: registration.participantId, gameId: game.id, reason: 'balanced' });
  }
  const unassigned = shuffledCandidates.slice(selectedCount).map((registration) => registration.participantId);
  return { assignments, unassigned, gameState, openSeatCount };
}
