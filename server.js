import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { createWorker } from "mediasoup";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let worker;
let router;

const peers = {}; // socketId -> { ws, transports, producers, consumers }

async function startWorker() {
  worker = await createWorker({
    logLevel: "warn",
    rtcMinPort: 20000,
    rtcMaxPort: 20200
  });

  worker.on("died", () => {
    console.error("Worker died, exiting...");
    process.exit(1);
  });

  console.log("Worker started, PID:", worker.pid);

  router = await worker.createRouter({
    mediaCodecs: [
      { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
      { kind: "video", mimeType: "video/VP8", clockRate: 90000 }
    ]
  });
}

function send(ws, type, data) {
  ws.send(JSON.stringify({ type, data }));
}

wss.on("connection", (ws) => {
  const socketId = Math.random().toString(36).substr(2, 9);
  console.log("Peer connected:", socketId);

  // Create peer object
  peers[socketId] = { 
    ws, 
    transports: new Map(), 
    producers: new Map(), 
    consumers: new Map(),
    sendTransport: null,
    recvTransport: null
  };

  // Send router RTP capabilities to peer
  send(ws, "rtpCapabilities", router.rtpCapabilities);

  ws.on("message", async (msg) => {
    const { type, data } = JSON.parse(msg);
    const peer = peers[socketId];

    try {
      if (type === "createWebRtcTransport") {
        const transport = await router.createWebRtcTransport({
          listenIps: [{ 
            ip: "127.0.0.1", 
            announcedIp: "127.0.0.1"
          }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true
        });
        
        peer.transports.set(transport.id, transport);

        // Determine transport type based on client's intent or current state
        const purpose = data?.purpose;
        const isSendTransport = purpose === 'send' || (!peer.sendTransport && purpose !== 'recv');
        
        if (isSendTransport && !peer.sendTransport) {
          peer.sendTransport = transport;
          console.log(`[${socketId}] Created send transport:`, transport.id);
        } else {
          peer.recvTransport = transport;
          console.log(`[${socketId}] Created recv transport:`, transport.id);
          
          // After recv transport is created, send existing producers from other peers
          setTimeout(() => {
            for (const id in peers) {
              if (id !== socketId) {
                const otherPeer = peers[id];
                for (const producer of otherPeer.producers.values()) {
                  console.log(`[${socketId}] Sending existing producer:`, producer.id, producer.kind);
                  send(ws, "newProducer", { producerId: producer.id, socketId: id });
                }
              }
            }
          }, 500);
        }

        send(ws, "createWebRtcTransport", {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters
        });
      }

      if (type === "connectTransport") {
        const transport = peer.transports.get(data.transportId);
        if (!transport) {
          console.error(`[${socketId}] Transport not found:`, data.transportId);
          return send(ws, "connectTransport", { error: "Transport not found" });
        }
        await transport.connect({ dtlsParameters: data.dtlsParameters });
        console.log(`[${socketId}] Transport connected:`, transport.id);
        send(ws, "connectTransport", { connected: true });
      }

      if (type === "produce") {
        const transport = peer.transports.get(data.transportId);
        if (!transport) {
          console.error(`[${socketId}] Transport not found for produce:`, data.transportId);
          return send(ws, "produce", { error: "Transport not found" });
        }
        
        console.log(`[${socketId}] Producing ${data.kind}, RTP parameters:`, {
          codecs: data.rtpParameters.codecs.map(c => c.mimeType),
          encodings: data.rtpParameters.encodings
        });
        
        const producer = await transport.produce({ 
          kind: data.kind, 
          rtpParameters: data.rtpParameters 
        });
        peer.producers.set(producer.id, producer);
        console.log(`[${socketId}] Produced ${data.kind}:`, producer.id, 
          `paused: ${producer.paused}, score: ${producer.score}`);

        // Notify all other peers about new producer
        for (const id in peers) {
          if (id !== socketId) {
            console.log(`[${socketId}] Notifying peer ${id} about producer:`, producer.id);
            send(peers[id].ws, "newProducer", { producerId: producer.id, socketId });
          }
        }

        send(ws, "produce", { id: producer.id });
      }

      if (type === "consume") {
        console.log(`[${socketId}] Consume request for producer:`, data.producerId);
        
        if (!router.canConsume({ 
          producerId: data.producerId, 
          rtpCapabilities: data.rtpCapabilities 
        })) {
          console.error(`[${socketId}] Cannot consume producer:`, data.producerId);
          return send(ws, "consume", { error: "Cannot consume" });
        }

        // Use the receive transport
        const recvTransport = peer.recvTransport;
        if (!recvTransport) {
          console.error(`[${socketId}] No receive transport available`);
          return send(ws, "consume", { error: "No receive transport" });
        }

        console.log(`[${socketId}] Creating consumer on transport:`, recvTransport.id);
        
        const consumer = await recvTransport.consume({
          producerId: data.producerId,
          rtpCapabilities: data.rtpCapabilities,
          paused: false
        });
        
        peer.consumers.set(consumer.id, consumer);
        console.log(`[${socketId}] Consumer created:`, consumer.id, consumer.kind);

        send(ws, "consume", {
          id: consumer.id,
          producerId: data.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters
        });
      }

    } catch (err) {
      console.error(`[${socketId}] ${type} error:`, err.message);
      send(ws, type, { error: err.message });
    }
  });

  ws.on("close", () => {
    console.log("Peer disconnected:", socketId);
    const peer = peers[socketId];
    if (peer) {
      for (const producer of peer.producers.values()) {
        console.log(`[${socketId}] Closing producer:`, producer.id);
        producer.close();
      }
      for (const consumer of peer.consumers.values()) {
        console.log(`[${socketId}] Closing consumer:`, consumer.id);
        consumer.close();
      }
      for (const transport of peer.transports.values()) {
        console.log(`[${socketId}] Closing transport:`, transport.id);
        transport.close();
      }
    }
    delete peers[socketId];
  });

  ws.on("error", (error) => {
    console.error(`[${socketId}] WebSocket error:`, error);
  });
});

async function main() {
  await startWorker();
  const PORT = 3000;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

main();