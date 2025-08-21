// /api/chat/index.js
// Secure Azure Function for HIPAA-compliant OpenAI integration

const { app } = require('@azure/functions');

// Security configuration
const ALLOWED_ORIGINS = [
    'https://mentora-app.azurestaticapps.net',
    'https://*.azurestaticapps.net' // For preview deployments
];

const MAX_MESSAGE_LENGTH = 4000;
const MAX_TOKENS = 1000;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30;

// Simple in-memory rate limiting (use Redis in production)
const rateLimitStore = new Map();

// Rate limiting function
function isRateLimited(clientId) {
    const now = Date.now();
    const clientData = rateLimitStore.get(clientId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
    
    if (now > clientData.resetTime) {
        clientData.count = 1;
        clientData.resetTime = now + RATE_LIMIT_WINDOW;
    } else {
        clientData.count++;
    }
    
    rateLimitStore.set(clientId, clientData);
    return clientData.count > RATE_LIMIT_MAX_REQUESTS;
}

// Input validation and sanitization
function validateAndSanitizeInput(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('Messages must be a non-empty array');
    }
    
    if (messages.length > 10) {
        throw new Error('Too many messages in conversation');
    }
    
    return messages.map(msg => {
        if (!msg.role || !msg.content) {
            throw new Error('Each message must have role and content');
        }
        
        if (!['user', 'assistant', 'system'].includes(msg.role)) {
            throw new Error('Invalid message role');
        }
        
        if (typeof msg.content !== 'string' || msg.content.length > MAX_MESSAGE_LENGTH) {
            throw new Error(`Message content too long (max ${MAX_MESSAGE_LENGTH} characters)`);
        }
        
        // Basic sanitization - remove potential PHI patterns
        const sanitizedContent = msg.content
            .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]') // SSN pattern
            .replace(/\b\d{10,16}\b/g, '[REDACTED-ID]') // Long ID numbers
            .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[REDACTED-EMAIL]'); // Email
        
        return {
            role: msg.role,
            content: sanitizedContent.trim()
        };
    });
}

// CORS headers
function getCorsHeaders(origin) {
    const isAllowedOrigin = ALLOWED_ORIGINS.some(allowedOrigin => {
        if (allowedOrigin.includes('*')) {
            const pattern = allowedOrigin.replace('*', '.*');
            return new RegExp(pattern).test(origin);
        }
        return allowedOrigin === origin;
    });
    
    return {
        'Access-Control-Allow-Origin': isAllowedOrigin ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-ID',
        'Access-Control-Max-Age': '86400',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block'
    };
}

// Main function
app.http('chat', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous', // Change to 'function' for API key auth in production
    handler: async (request, context) => {
        const startTime = Date.now();
        const correlationId = crypto.randomUUID();
        
        try {
            // Set correlation ID for logging
            context.log(`[${correlationId}] Chat request initiated`);
            
            // Get origin for CORS
            const origin = request.headers.get('origin') || request.headers.get('Origin');
            const corsHeaders = getCorsHeaders(origin);
            
            // Handle preflight OPTIONS request
            if (request.method === 'OPTIONS') {
                return {
                    status: 200,
                    headers: corsHeaders
                };
            }
            
            // Rate limiting
            const clientId = request.headers.get('x-forwarded-for') || 
                           request.headers.get('x-session-id') || 
                           'anonymous';
            
            if (isRateLimited(clientId)) {
                context.log(`[${correlationId}] Rate limit exceeded for client: ${clientId}`);
                return {
                    status: 429,
                    headers: corsHeaders,
                    jsonBody: { 
                        error: 'Too many requests. Please try again later.',
                        correlationId 
                    }
                };
            }
            
            // Validate environment variables
            const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
            const apiKey = process.env.AZURE_OPENAI_KEY;
            const deploymentName = process.env.DEPLOYMENT_NAME;
            const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';
            
            if (!endpoint || !apiKey || !deploymentName) {
                context.log(`[${correlationId}] Missing environment variables`);
                return {
                    status: 500,
                    headers: corsHeaders,
                    jsonBody: { 
                        error: 'Service configuration error',
                        correlationId 
                    }
                };
            }
            
            // Parse and validate request body
            let requestBody;
            try {
                requestBody = await request.json();
            } catch (error) {
                context.log(`[${correlationId}] Invalid JSON in request body`);
                return {
                    status: 400,
                    headers: corsHeaders,
                    jsonBody: { 
                        error: 'Invalid JSON format',
                        correlationId 
                    }
                };
            }
            
            const { messages, maxTokens = 800, temperature = 0.7 } = requestBody;
            
            // Validate and sanitize messages
            let sanitizedMessages;
            try {
                sanitizedMessages = validateAndSanitizeInput(messages);
            } catch (error) {
                context.log(`[${correlationId}] Input validation failed: ${error.message}`);
                return {
                    status: 400,
                    headers: corsHeaders,
                    jsonBody: { 
                        error: error.message,
                        correlationId 
                    }
                };
            }
            
            // Add system message for healthcare context
            const systemMessage = {
                role: 'system',
                content: 'You are a helpful AI assistant for a dental practice management system. Provide general information only. Do not provide medical advice, diagnoses, or treatment recommendations. Always remind users to consult with their healthcare provider for medical concerns.'
            };
            
            const finalMessages = [systemMessage, ...sanitizedMessages];
            
            // Construct Azure OpenAI URL
            const url = `${endpoint}openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;
            
            context.log(`[${correlationId}] Calling Azure OpenAI`);
            
            // Make request to Azure OpenAI
            const openaiResponse = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': apiKey,
                    'User-Agent': 'Mentora-EHR/1.0'
                },
                body: JSON.stringify({
                    messages: finalMessages,
                    max_tokens: Math.min(maxTokens, MAX_TOKENS),
                    temperature: Math.max(0.1, Math.min(temperature, 1.0)),
                    top_p: 0.9,
                    frequency_penalty: 0.1,
                    presence_penalty: 0.1
                })
            });
            
            if (!openaiResponse.ok) {
                const errorText = await openaiResponse.text();
                context.log(`[${correlationId}] Azure OpenAI Error: ${openaiResponse.status} - ${errorText}`);
                
                // Don't expose internal errors to client
                return {
                    status: 503,
                    headers: corsHeaders,
                    jsonBody: { 
                        error: 'AI service temporarily unavailable. Please try again.',
                        correlationId 
                    }
                };
            }
            
            const aiResponse = await openaiResponse.json();
            
            // Log successful completion
            const duration = Date.now() - startTime;
            context.log(`[${correlationId}] Request completed successfully in ${duration}ms`);
            
            // Return sanitized response
            return {
                status: 200,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json',
                    'X-Correlation-ID': correlationId
                },
                jsonBody: {
                    choices: aiResponse.choices,
                    usage: aiResponse.usage,
                    correlationId
                }
            };
            
        } catch (error) {
            const duration = Date.now() - startTime;
            context.log(`[${correlationId}] Unhandled error after ${duration}ms:`, error);
            
            return {
                status: 500,
                headers: getCorsHeaders(request.headers.get('origin')),
                jsonBody: { 
                    error: 'An unexpected error occurred. Please try again.',
                    correlationId 
                }
            };
        }
    }
});
