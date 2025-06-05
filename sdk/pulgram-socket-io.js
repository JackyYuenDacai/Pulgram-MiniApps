/**
 * PulgramSocketIO - A Socket.IO compatible adapter for Pulgram
 * 
 * This adapter provides a Socket.IO-like interface that works with Pulgram Bridge
 * and internally uses PulgramSocket for communication.
 * 
 * Key Socket.IO features supported:
 * - connect/disconnect events
 * - emit/on for sending/receiving events
 * - rooms (simulated via PulgramSocket's host-client architecture)
 * - namespaces
 */

// Get reference to the PulgramSocket class
const PulgramSocket = window.PulgramSocket || require('./pulram-socket').default;

class PulgramSocketIO {
    constructor(options = {}) {
        this.options = Object.assign({
            autoConnect: true
        }, options);
        
        this.connected = false;
        this.disconnected = true;
        this.id = null;
        this.namespaces = new Map();
        this._rooms = new Set(); // rooms the socket is currently in
        this._defaultNamespace = this._createNamespace('/');
    }

    /**
     * Create a namespace object
     * @param {string} name - Namespace name (e.g. '/' or '/chat')
     * @returns {Object} Namespace object
     * @private
     */
    _createNamespace(name) {
        if (!name.startsWith('/')) {
            name = '/' + name;
        }

        // Use PulgramSocket with the namespace name (without leading '/')
        const namespace = name === '/' ? 'default' : name.substring(1);
        
        // Create a new PulgramSocket for this namespace
        const socket = new PulgramSocket(namespace);

        // Set up basic Socket.IO events
        this._setupSocketIOEvents(socket);
        
        const namespaceObj = {
            name,
            socket,
            connected: false,
            eventListeners: {}
        };
        
        this.namespaces.set(name, namespaceObj);
        return namespaceObj;
    }

    /**
     * Set up standard Socket.IO events on the PulgramSocket instance
     * @param {PulgramSocket} socket - The PulgramSocket instance
     * @private
     */
    _setupSocketIOEvents(socket) {
        // Map PulgramSocket events to Socket.IO events
        socket.on('connected', (data) => {
            const userId = window.pulgram.getUserId();
            this.id = userId;
            this.connected = true;
            this.disconnected = false;
            
            socket._triggerEvent('connect', {});
            
            // Emit additional connection info similar to Socket.IO
            socket._triggerEvent('connection', {
                id: userId,
                isHost: data.isHost
            });
        });

        // Map user_left event to Socket.IO disconnect event
        socket.on('user_left', (data) => {
            socket._triggerEvent('disconnect', {
                reason: 'transport close',
                userId: data.userId
            });
        });

        // Map host_changed event to custom event
        socket.on('host_changed', (data) => {
            socket._triggerEvent('host', data);
        });
    }

    /**
     * Connect to the Socket.IO server (or in our case, the PulgramSocket network)
     * @returns {PulgramSocketIO} this instance for chaining
     */
    connect() {
        // Connect the default namespace first
        this._defaultNamespace.socket.connect();
        this._defaultNamespace.connected = true;
        
        // Connect any other namespaces that have been created
        for (const [name, ns] of this.namespaces.entries()) {
            if (name !== '/' && !ns.connected) {
                ns.socket.connect();
                ns.connected = true;
            }
        }
        
        return this;
    }

    /**
     * Close the socket connection
     * @returns {PulgramSocketIO} this instance for chaining
     */
    close() {
        return this.disconnect();
    }

    /**
     * Disconnect from the Socket.IO server
     * @returns {PulgramSocketIO} this instance for chaining
     */
    disconnect() {
        // Disconnect all namespaces
        for (const [_, ns] of this.namespaces.entries()) {
            ns.socket.disconnect();
            ns.connected = false;
        }
        
        this.connected = false;
        this.disconnected = true;
        
        return this;
    }

    /**
     * Get or create a namespace
     * @param {string} name - Namespace name
     * @returns {Object} Namespace socket object
     */
    of(name) {
        if (!name.startsWith('/')) {
            name = '/' + name;
        }
        
        // Return existing namespace or create new one
        if (!this.namespaces.has(name)) {
            return this._createNamespace(name);
        }
        
        return this.namespaces.get(name);
    }

    /**
     * Register an event listener on the default namespace
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {PulgramSocketIO} this instance for chaining
     */
    on(event, callback) {
        this._defaultNamespace.socket.on(event, callback);
        return this;
    }

    /**
     * Remove an event listener from the default namespace
     * @param {string} event - Event name
     * @param {Function} callback - Callback function to remove
     * @returns {PulgramSocketIO} this instance for chaining
     */
    off(event, callback) {
        this._defaultNamespace.socket.off(event, callback);
        return this;
    }

    /**
     * Emit an event to the server
     * @param {string} event - Event name
     * @param {...any} args - Event data and optional callback
     * @returns {PulgramSocketIO} this instance for chaining
     */
    emit(event, ...args) {
        // Check for callback function as the last argument
        let callback;
        let data;
        
        if (typeof args[args.length - 1] === 'function') {
            callback = args.pop();
            data = args.length > 0 ? args[0] : null;
        } else {
            data = args.length > 0 ? args[0] : null;
        }
        
        // Emit the event through the default namespace socket
        this._defaultNamespace.socket.emit(event, data);
        
        // If a callback was provided, call it after a short delay to simulate ACK
        if (callback) {
            setTimeout(() => {
                callback();
            }, 10);
        }
        
        return this;
    }

    /**
     * Join a room - in Pulgram, rooms are simulated since we have host-client topology
     * @param {string|Array<string>} rooms - Room or rooms to join
     * @returns {PulgramSocketIO} this instance for chaining
     */
    join(rooms) {
        const roomArray = Array.isArray(rooms) ? rooms : [rooms];
        
        // In our implementation, joining a room just means we're tracking it locally
        // and will include the room information when sending messages
        roomArray.forEach(room => {
            this._rooms.add(room);
            
            // Emit join event to notify others (if we're the host)
            if (this._defaultNamespace.socket.isHost) {
                this._defaultNamespace.socket.broadcast('_room_join', {
                    userId: window.pulgram.getUserId(),
                    room: room
                });
            }
        });
        
        return this;
    }

    /**
     * Leave a room
     * @param {string|Array<string>} rooms - Room or rooms to leave
     * @returns {PulgramSocketIO} this instance for chaining
     */
    leave(rooms) {
        const roomArray = Array.isArray(rooms) ? rooms : [rooms];
        
        roomArray.forEach(room => {
            this._rooms.delete(room);
            
            // Emit leave event to notify others (if we're the host)
            if (this._defaultNamespace.socket.isHost) {
                this._defaultNamespace.socket.broadcast('_room_leave', {
                    userId: window.pulgram.getUserId(),
                    room: room
                });
            }
        });
        
        return this;
    }

    /**
     * Get the rooms that this socket is in
     * @returns {Set<string>} Set of room names
     */
    get rooms() {
        return this._rooms;
    }
    
    /**
     * Check if the socket is connected
     * @returns {boolean} True if connected
     */
    get connected() {
        return this._connected;
    }
    
    /**
     * Set the connected state
     */
    set connected(value) {
        this._connected = value;
    }
    
    /**
     * Check if the socket is disconnected
     * @returns {boolean} True if disconnected
     */
    get disconnected() {
        return this._disconnected;
    }
    
    /**
     * Set the disconnected state
     */
    set disconnected(value) {
        this._disconnected = value;
    }
    
    /**
     * Get the socket ID (user ID in Pulgram)
     * @returns {string|null} Socket ID
     */
    get id() {
        return this._id;
    }
    
    /**
     * Set the socket ID
     */
    set id(value) {
        this._id = value;
    }

    /**
     * Create a Socket.IO compatible socket
     * @param {string|Object} uri - Connection URI or options
     * @param {Object} opts - Socket options
     * @returns {PulgramSocketIO} A new PulgramSocketIO instance
     */
    static io(uri, opts = {}) {
        // Parse URI if string
        let options = opts;
        
        if (typeof uri === 'object') {
            options = uri;
        } else if (typeof uri === 'string') {
            // Extract namespace from URI if present
            const parts = uri.split('/');
            const namespace = parts.length > 3 ? '/' + parts.slice(3).join('/') : '/';
            
            options = {
                ...opts,
                namespace
            };
        }
        
        const socket = new PulgramSocketIO(options);
        
        // Auto-connect unless disabled
        if (options.autoConnect !== false) {
            socket.connect();
        }
        
        return socket;
    }
}

// Namespace compatibility for standard Socket.IO usage
PulgramSocketIO.Socket = PulgramSocketIO;
PulgramSocketIO.connect = PulgramSocketIO.io;

// Export as both module export and global
export default PulgramSocketIO;
window.io = PulgramSocketIO.io;
