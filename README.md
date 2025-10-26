1. User clicks "Start"
   ↓
2. Browser creates WebSocket connection to server
   ws = new WebSocket("ws://localhost:3000")
   ↓
3. Server receives connection
   - Generates socketId: "abc123"
   - Creates peer object: peers["abc123"] = { ws, transports, producers }
   ↓
4. Server sends RTP capabilities
   Server → Sender: { type: "rtpCapabilities", data: {...codecs, headerExtensions...} }
   ↓
5. Sender loads mediasoup Device
   device = new Device()
   device.load(routerRtpCapabilities)
   ↓
6. Sender requests transport creation
   Sender → Server: { type: "createWebRtcTransport", data: { purpose: "send" } }
```

---

### **Phase 2: Transport Creation (WebRTC Setup)**
```
7. Server creates WebRTC transport
   transport = router.createWebRtcTransport({
     listenIps: [{ ip: "127.0.0.1", announcedIp: "127.0.0.1" }],
     ports: 20000-20200
   })
   ↓
8. Server sends transport parameters back
   Server → Sender: {
     type: "createWebRtcTransport",
     data: {
       id: "transport-xyz",
       iceParameters: {...},      // For NAT traversal
       iceCandidates: [{...}],    // Network addresses
       dtlsParameters: {...}      // For encryption
     }
   }
   ↓
9. Sender creates sendTransport
   sendTransport = device.createSendTransport({...transportParams})
```

---

### **Phase 3: Media Capture & Production**
```
10. Sender requests camera/microphone access
    stream = await getUserMedia({ audio: true, video: true })
    ↓
11. Browser prompts user for permission
    [Allow Camera/Microphone] ✓
    ↓
12. Stream received with 2 tracks:
    - MediaStreamTrack { kind: "audio", ... }
    - MediaStreamTrack { kind: "video", ... }
    ↓
13. Display local video
    localVideo.srcObject = stream
    ↓
14. For each track, produce it:
    
    FOR AUDIO TRACK:
    ----------------
    producer = await sendTransport.produce({ track: audioTrack })
    ↓
    sendTransport fires "produce" event
    ↓
    Sender → Server: {
      type: "produce",
      data: {
        transportId: "transport-xyz",
        kind: "audio",
        rtpParameters: {
          codecs: [{ mimeType: "audio/opus", ... }],
          encodings: [{ ssrc: 12345 }]  // Unique stream ID
        }
      }
    }
    ↓
    Server creates Producer
    producer = transport.produce({ kind: "audio", rtpParameters })
    peers["abc123"].producers.set(producerId, producer)
    ↓
    Server → Sender: { type: "produce", data: { id: "producer-audio-123" } }
    
    
    FOR VIDEO TRACK:
    ----------------
    (Same flow, but kind: "video", codec: VP8)
    Server → Sender: { type: "produce", data: { id: "producer-video-456" } }
```

---

### **Phase 4: Receiver Joins**

#### **Receiver Tab clicks "Start" (Receive Mode)**
```
15. Receiver connects via WebSocket
    socketId: "def456"
    ↓
16. Server sends RTP capabilities
    Server → Receiver: { type: "rtpCapabilities", data: {...} }
    ↓
17. Receiver loads device & requests transport
    Receiver → Server: { type: "createWebRtcTransport", data: { purpose: "recv" } }
    ↓
18. Server creates receive transport
    Server → Receiver: { type: "createWebRtcTransport", data: {...transportParams} }
    ↓
19. Receiver creates recvTransport
    recvTransport = device.createRecvTransport({...})
```

---

### **Phase 5: Notifying About Existing Producers**
```
20. Server detects receiver's transport is ready
    ↓
21. Server loops through all existing producers
    for (peer "abc123") {
      for (producer "producer-audio-123") {
        Server → Receiver: {
          type: "newProducer",
          data: {
            producerId: "producer-audio-123",
            socketId: "abc123"
          }
        }
      }
      for (producer "producer-video-456") {
        Server → Receiver: {
          type: "newProducer",
          data: {
            producerId: "producer-video-456",
            socketId: "abc123"
          }
        }
      }
    }
```

---

### **Phase 6: Consuming Media**
```
22. Receiver receives "newProducer" notification
    ↓
23. Receiver requests to consume
    Receiver → Server: {
      type: "consume",
      data: {
        producerId: "producer-audio-123",
        rtpCapabilities: device.rtpCapabilities
      }
    }
    ↓
24. Server checks if consumption is possible
    if (router.canConsume({ producerId, rtpCapabilities })) {
      ↓
25. Server creates Consumer
      consumer = recvTransport.consume({
        producerId: "producer-audio-123",
        rtpCapabilities: receiverRtpCapabilities,
        paused: false
      })
      ↓
26. Server → Receiver: {
      type: "consume",
      data: {
        id: "consumer-audio-789",
        producerId: "producer-audio-123",
        kind: "audio",
        rtpParameters: {...} 
      }
    }
    ↓
27. Receiver creates consumer
    consumer = await recvTransport.consume({
      id: "consumer-audio-789",
      producerId: "producer-audio-123",
      kind: "audio",
      rtpParameters: {...}
    })
    ↓
28. Consumer provides MediaStreamTrack
    track = consumer.track  // This is the actual media!
    ↓
29. Add track to video element
    remoteVideo.srcObject = new MediaStream()
    remoteVideo.srcObject.addTrack(track)
    ↓
30. Video element starts playing
    remoteVideo.play()
