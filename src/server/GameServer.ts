import { RateLimiterMemory } from "rate-limiter-flexible";
import WebSocket from "ws";
import {
  ClientID,
  ClientMessage,
  ClientMessageSchema,
  GameConfig,
  GameInfo,
  Intent,
  PlayerRecord,
  ServerDesyncSchema,
  ServerStartGameMessageSchema,
  ServerTurnMessageSchema,
  Turn,
} from "../core/Schemas";
import { CreateGameRecord } from "../core/Util";
import { ServerConfig } from "../core/configuration/Config";
import { GameType } from "../core/game/Game";
import { archive } from "./Archive";
import { Client } from "./Client";
import { slog } from "./StructuredLog";
import { securityMiddleware } from "./Security";
import { consolex } from "../core/Consolex";

export enum GamePhase {
  Lobby = "LOBBY",
  Active = "ACTIVE",
  Finished = "FINISHED",
}

export class GameServer {
  private outOfSyncClients = new Set<ClientID>();

  private maxGameDuration = 3 * 60 * 60 * 1000; // 3 hours

  private _scheduledStartTime: number;
  private _minExtensionTime: number = 10 * 1000;

  private turns: Turn[] = [];
  private intents: Intent[] = [];
  public activeClients: Client[] = [];
  // Used for record record keeping
  private allClients: Map<ClientID, Client> = new Map();
  private _hasStarted = false;
  private _startTime: number = null;

  private endTurnIntervalID;

  private lastPingUpdate = 0;

  private winner: ClientID | null = null;

  constructor(
    public readonly id: string,
    public readonly createdAt: number,
    public readonly highTraffic: boolean,
    private config: ServerConfig,
    public gameConfig: GameConfig,
  ) {
    this._scheduledStartTime =
      this.createdAt + this.config.initialLobbyLifetime();
    consolex.log(
      `${this.id}: Created game with scheduled start at ${new Date(this._scheduledStartTime).toISOString()}`,
    );
  }

  private determineGameState(): GamePhase {
    // Already started games stay ACTIVE (or FINISHED if conditions met)
    if (this._hasStarted) {
      const noRecentPings = Date.now() > this.lastPingUpdate + 20 * 1000;
      const noActive = this.activeClients.length === 0;

      if (noActive && noRecentPings) {
        return GamePhase.Finished;
      }
      return GamePhase.Active;
    }

    // Non-public games in lobby
    if (!this.isPublic()) {
      return GamePhase.Lobby;
    }

    // Now handle public games that haven't started
    const now = Date.now();
    const currentPlayers = this.numClients();
    const minPlayers = this.config.minPlayerThreshold();

    // First check: Is it time to start the game?
    if (now >= this._scheduledStartTime && currentPlayers >= minPlayers) {
      // We have enough players and time has elapsed - start the game!
      consolex.log(
        `${this.id}: Starting game with ${currentPlayers}/${minPlayers} players`,
      );
      this.start();
      return GamePhase.Active;
    }

    // Second check: Should we extend the time?
    if (now >= this._scheduledStartTime && currentPlayers < minPlayers) {
      // Time elapsed but not enough players - extend the timer
      this._scheduledStartTime = now + 15 * 1000;
      consolex.log(
        `${this.id}: Extended lobby time to ${new Date(this._scheduledStartTime).toISOString()} (${currentPlayers}/${minPlayers} players)`,
      );
    }

    // Third check: Should we reduce the time?
    if (
      now < this._scheduledStartTime &&
      currentPlayers >= this.config.targetPlayerCount()
    ) {
      // We reached target player count - start sooner
      const minTimeFromNow = 10 * 1000; // 10 seconds
      const newStartTime = now + minTimeFromNow;

      if (newStartTime < this._scheduledStartTime) {
        this._scheduledStartTime = newStartTime;
        console.log(
          `${this.id}: Target players reached, starting in ${minTimeFromNow / 1000} seconds`,
        );
      }
    }

    // Still in LOBBY
    return GamePhase.Lobby;
  }

  public remainingLobbyTime(): number {
    if (this._hasStarted || !this.isPublic()) {
      return 0;
    }

    const now = Date.now();
    return Math.max(0, this._scheduledStartTime - now);
  }

  private updateScheduledStartTime(): void {
    if (this._hasStarted) {
      console.log(
        `${this.id}: Skipping extension because game has already started`,
      );
      return;
    }
    const now = Date.now();
    const currentPlayers = this.numClients();
    const minPlayers = this.config.minPlayerThreshold();

    if (now >= this._scheduledStartTime && currentPlayers < minPlayers) {
      // Extend by 30 seconds from now
      this._scheduledStartTime = now + 30 * 1000;
      console.log(
        `${this.id}: Extended lobby time to ${new Date(this._scheduledStartTime).toISOString()} (${currentPlayers}/${minPlayers} players)`,
      );
    }

    // If we have target players, start sooner (but ensure at least minimal time)
    const targetPlayers = this.config.targetPlayerCount();
    if (currentPlayers >= targetPlayers) {
      const minimumStart = now + this._minExtensionTime;
      if (this._scheduledStartTime > minimumStart) {
        this._scheduledStartTime = minimumStart;
        console.log(
          `${this.id}: Target players reached, starting in ${this._minExtensionTime / 1000} seconds`,
        );
      }
    }

    // If we have many players but not target, reduce time proportionally
    if (currentPlayers >= minPlayers && currentPlayers < targetPlayers) {
      const originalStart = this.createdAt + this.config.initialLobbyLifetime();
      const fullDuration = originalStart - this.createdAt;

      // Calculate percentage between min and target
      const progress =
        (currentPlayers - minPlayers) / (targetPlayers - minPlayers);
      const reduction = fullDuration * (progress * 0.8); // Up to 80% reduction

      const newStartTime = originalStart - reduction;

      // Don't move the time forward, only reduce it
      if (newStartTime < this._scheduledStartTime) {
        this._scheduledStartTime = Math.max(
          now + this._minExtensionTime,
          newStartTime,
        );
      }
    }
  }

  public updateGameConfig(gameConfig: GameConfig): void {
    if (gameConfig.gameMap != null) {
      this.gameConfig.gameMap = gameConfig.gameMap;
    }
    if (gameConfig.difficulty != null) {
      this.gameConfig.difficulty = gameConfig.difficulty;
    }
    if (gameConfig.disableNPCs != null) {
      this.gameConfig.disableNPCs = gameConfig.disableNPCs;
    }
    if (gameConfig.bots != null) {
      this.gameConfig.bots = gameConfig.bots;
    }
    if (gameConfig.infiniteGold != null) {
      this.gameConfig.infiniteGold = gameConfig.infiniteGold;
    }
    if (gameConfig.infiniteTroops != null) {
      this.gameConfig.infiniteTroops = gameConfig.infiniteTroops;
    }
    if (gameConfig.instantBuild != null) {
      this.gameConfig.instantBuild = gameConfig.instantBuild;
    }
  }

  public addClient(client: Client, lastTurn: number) {
    console.log(`${this.id}: adding client ${client.clientID}`);
    slog({
      logKey: "client_joined_game",
      msg: `client ${client.clientID} (re)joining game ${this.id}`,
      data: {
        clientID: client.clientID,
        clientIP: client.ip,
        gameID: this.id,
        isRejoin: lastTurn > 0,
      },
      clientID: client.clientID,
      persistentID: client.persistentID,
      gameID: this.id,
    });

    if (
      this.gameConfig.gameType == GameType.Public &&
      this.activeClients.filter(
        (c) => c.ip == client.ip && c.clientID != client.clientID,
      ).length >= 3
    ) {
      console.log(
        `cannot add client ${client.clientID}, already have 3 ips (${client.ip})`,
      );
      return;
    }

    // Remove stale client if this is a reconnect
    const existing = this.activeClients.find(
      (c) => c.clientID == client.clientID,
    );
    if (existing != null) {
      existing.ws.removeAllListeners("message");
    }
    this.activeClients = this.activeClients.filter(
      (c) => c.clientID != client.clientID,
    );
    this.activeClients.push(client);
    client.lastPing = Date.now();

    this.allClients.set(client.clientID, client);

    client.ws.on(
      "message",
      securityMiddleware.wsHandler(client.ip, async (message: string) => {
        try {
          let clientMsg: ClientMessage = null;
          try {
            clientMsg = ClientMessageSchema.parse(JSON.parse(message));
          } catch (error) {
            throw Error(`error parsing schema for ${client.ip}`);
          }
          if (this.allClients.has(clientMsg.clientID)) {
            const client = this.allClients.get(clientMsg.clientID);
            if (client.persistentID != clientMsg.persistentID) {
              console.warn(
                `Client ID ${clientMsg.clientID} sent incorrect id ${clientMsg.persistentID}, does not match persistent id ${client.persistentID}`,
              );
              return;
            }
          }

          // Clear out persistent id to make sure it doesn't get sent to other clients.
          clientMsg.persistentID = null;

          if (clientMsg.type == "intent") {
            if (clientMsg.gameID == this.id) {
              this.addIntent(clientMsg.intent);
            } else {
              console.warn(
                `${this.id}: client ${clientMsg.clientID} sent to wrong game`,
              );
            }
          }
          if (clientMsg.type == "ping") {
            this.lastPingUpdate = Date.now();
            client.lastPing = Date.now();
          }
          if (clientMsg.type == "hash") {
            client.hashes.set(clientMsg.tick, clientMsg.hash);
          }
          if (clientMsg.type == "winner") {
            this.winner = clientMsg.winner;
          }
        } catch (error) {
          console.log(
            `error handline websocket request in game server: ${error}`,
          );
        }
      }),
    );
    client.ws.on("close", () => {
      console.log(`${this.id}: client ${client.clientID} disconnected`);
      this.activeClients = this.activeClients.filter(
        (c) => c.clientID != client.clientID,
      );
    });
    client.ws.on("error", (error: Error) => {
      if ((error as any).code === "WS_ERR_UNEXPECTED_RSV_1") {
        client.ws.close(1002);
      }
    });

    // In case a client joined the game late and missed the start message.
    if (this._hasStarted) {
      this.sendStartGameMsg(client.ws, lastTurn);
    }
  }

  public numClients(): number {
    return this.activeClients.length;
  }

  public startTime(): number {
    if (this._startTime > 0) {
      // Game has already started, return actual start time
      return this._startTime;
    } else if (this.isPublic()) {
      // Return the scheduled start time
      return this._scheduledStartTime;
    } else {
      // Non-public games
      return Date.now();
    }
  }

  public start() {
    if (this._hasStarted) {
      return; // Don't start twice
    }

    console.log(`${this.id}: GAME STARTING NOW`);
    this._hasStarted = true;
    this._startTime = Date.now();

    // Set last ping to start time so we don't immediately stop the game
    this.lastPingUpdate = Date.now();

    this.endTurnIntervalID = setInterval(
      () => this.endTurn(),
      this.config.turnIntervalMs(),
    );

    this.activeClients.forEach((c) => {
      consolex.log(`${this.id}: sending start message to ${c.clientID}`);
      this.sendStartGameMsg(c.ws, 0);
    });
  }

  private addIntent(intent: Intent) {
    this.intents.push(intent);
  }

  private sendStartGameMsg(ws: WebSocket, lastTurn: number) {
    try {
      ws.send(
        JSON.stringify(
          ServerStartGameMessageSchema.parse({
            type: "start",
            turns: this.turns.slice(lastTurn),
            config: this.gameConfig,
          }),
        ),
      );
    } catch (error) {
      throw new Error(`error sending start message for game ${this.id}`);
    }
  }

  private endTurn() {
    const pastTurn: Turn = {
      turnNumber: this.turns.length,
      gameID: this.id,
      intents: this.intents,
    };
    this.turns.push(pastTurn);
    this.intents = [];

    this.maybeSendDesync();

    let msg = "";
    try {
      msg = JSON.stringify(
        ServerTurnMessageSchema.parse({
          type: "turn",
          turn: pastTurn,
        }),
      );
    } catch (error) {
      console.log(`error sending message for game ${this.id}`);
      return;
    }

    this.activeClients.forEach((c) => {
      c.ws.send(msg);
    });
  }

  async end() {
    // Close all WebSocket connections
    clearInterval(this.endTurnIntervalID);
    this.allClients.forEach((client) => {
      client.ws.removeAllListeners("message");
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close(1000, "game has ended");
      }
    });
    console.log(
      `${this.id}: ending game ${this.id} with ${this.turns.length} turns`,
    );
    try {
      if (this.allClients.size > 0) {
        const playerRecords: PlayerRecord[] = Array.from(
          this.allClients.values(),
        ).map((client) => ({
          ip: client.ip,
          clientID: client.clientID,
          username: client.username,
          persistentID: client.persistentID,
        }));
        archive(
          CreateGameRecord(
            this.id,
            this.gameConfig,
            playerRecords,
            this.turns,
            this._startTime,
            Date.now(),
            this.winner,
          ),
        );
      } else {
        console.log(`${this.id}: no clients joined, not archiving game`);
      }
    } catch (error) {
      let errorDetails;
      if (error instanceof Error) {
        errorDetails = {
          message: error.message,
          stack: error.stack,
        };
      } else if (Array.isArray(error)) {
        errorDetails = error; // Now we'll actually see the array contents
      } else {
        try {
          errorDetails = JSON.stringify(error, null, 2);
        } catch (e) {
          errorDetails = String(error);
        }
      }

      console.error("Error archiving game record details:", {
        gameId: this.id,
        errorType: typeof error,
        error: errorDetails,
      });
    }
  }

  public phase(): GamePhase {
    // Handle client cleanup
    const now = Date.now();
    const alive = [];
    for (const client of this.activeClients) {
      if (now - client.lastPing > 60_000) {
        console.log(
          `${this.id}: no pings from ${client.clientID}, terminating connection`,
        );
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.close(1000, "no heartbeats received, closing connection");
        }
      } else {
        alive.push(client);
      }
    }
    this.activeClients = alive;

    // Check max duration
    if (now > this.createdAt + this.maxGameDuration) {
      console.warn(`${this.id}: game past max duration ${this.id}`);
      return GamePhase.Finished;
    }

    // Determine actual phase
    return this.determineGameState();
  }

  hasStarted(): boolean {
    return this._hasStarted;
  }

  public gameInfo(): GameInfo {
    // This call ensures our state is up-to-date
    this.determineGameState();

    return {
      gameID: this.id,
      clients: this.activeClients.map((c) => ({
        username: c.username,
        clientID: c.clientID,
      })),
      gameConfig: this.gameConfig,
      msUntilStart: this._hasStarted ? Date.now() : this._scheduledStartTime,
      hasStarted: this._hasStarted,

      // Additional UI info
      currentPlayers: this.numClients(),
      targetPlayers: this.config.targetPlayerCount(),
      minPlayers: this.config.minPlayerThreshold(),
    };
  }

  public isPublic(): boolean {
    return this.gameConfig.gameType == GameType.Public;
  }

  private maybeSendDesync() {
    if (this.activeClients.length <= 1) {
      return;
    }
    if (this.turns.length % 10 == 0 && this.turns.length != 0) {
      const lastHashTurn = this.turns.length - 10;

      let { mostCommonHash, outOfSyncClients } =
        this.findOutOfSyncClients(lastHashTurn);

      if (
        outOfSyncClients.length >= Math.floor(this.activeClients.length / 2)
      ) {
        // If half clients out of sync assume all are out of sync.
        outOfSyncClients = this.activeClients;
      }

      for (const oos of outOfSyncClients) {
        if (!this.outOfSyncClients.has(oos.clientID)) {
          console.warn(
            `Game ${this.id}: has out of sync client ${oos.clientID} on turn ${lastHashTurn}`,
          );
          this.outOfSyncClients.add(oos.clientID);
        }
      }
      return;
      // TODO: renable this once desync issue fixed

      const serverDesync = ServerDesyncSchema.safeParse({
        type: "desync",
        turn: lastHashTurn,
        correctHash: mostCommonHash,
        clientsWithCorrectHash:
          this.activeClients.length - outOfSyncClients.length,
        totalActiveClients: this.activeClients.length,
      });
      if (serverDesync.success) {
        const desyncMsg = JSON.stringify(serverDesync.data);
        for (const c of outOfSyncClients) {
          console.log(
            `game: ${this.id}: sending desync to client ${c.clientID}`,
          );
          c.ws.send(desyncMsg);
        }
      } else {
        console.warn(`failed to create desync message ${serverDesync.error}`);
      }
    }
  }

  findOutOfSyncClients(turnNumber: number): {
    mostCommonHash: number | null;
    outOfSyncClients: Client[];
  } {
    const counts = new Map<number, number>();

    // Count occurrences of each hash
    for (const client of this.activeClients) {
      if (client.hashes.has(turnNumber)) {
        const clientHash = client.hashes.get(turnNumber)!;
        counts.set(clientHash, (counts.get(clientHash) || 0) + 1);
      }
    }

    // Find the most common hash
    let mostCommonHash: number | null = null;
    let maxCount = 0;

    for (const [hash, count] of counts.entries()) {
      if (count > maxCount) {
        mostCommonHash = hash;
        maxCount = count;
      }
    }

    // Create a list of clients whose hash doesn't match the most common one
    const outOfSyncClients: Client[] = [];

    for (const client of this.activeClients) {
      if (client.hashes.has(turnNumber)) {
        const clientHash = client.hashes.get(turnNumber)!;
        if (clientHash !== mostCommonHash) {
          outOfSyncClients.push(client);
        }
      }
    }

    return {
      mostCommonHash,
      outOfSyncClients,
    };
  }
}
