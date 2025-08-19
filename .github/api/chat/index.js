// api/chat/index.js - Secure Azure Function for handling patient data
const { app } = require('@azure/functions');

app.http('chat', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log(`Http function processed request for url "${request.url}"`);

        // Set CORS headers for your domain
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*', // In production, set this to your specific domain
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': 'application/json'
        };

        // Handle preflight requests
        if (request.method === 'OPTIONS') {
            return {
                status: 200,
                headers: corsHeaders
            };
        }

        try {
            // Get configuration from environment variables (secure)
            const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
            const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY;
            const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME || 'note-gen-agent';

            // Validate configuration
            if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_KEY) {
                return {
                    status: 500,
                    headers: corsHeaders,
                    body: JSON.stringify({
                        success: false,
                        error: 'Azure OpenAI configuration missing. Please check environment variables.'
                    })
                };
            }

            // Parse request body
            const requestBody = await request.json();
            const { message, action, patientData } = requestBody;

            // Log for debugging (remove patient data in production)
            context.log('Request received:', { action, messageLength: message?.length });

            // Build system message based on action
            let systemMessage = "You are an AI clinical documentation assistant for orthodontic practices.";
            let userMessage = message;

            if (action === 'generateNote') {
                systemMessage = `You are an AI clinical documentation assistant for orthodontic practices. 
                Generate a comprehensive clinical note for today's orthodontic visit. Include:
                - Current treatment status and progress
                - Wire changes and adjustments made
                - Elastic compliance assessment
                - Clinical observations
                - Next steps and recommendations
                - Next appointment scheduling
                
                Format as a professional clinical note suitable for EHR documentation.`;
                
                userMessage = patientData ? 
                    `Generate a clinical note for ${patientData.name}'s visit today. Current treatment: ${patientData.treatment || 'orthodontic treatment'}` :
                    "Generate a clinical note for today's orthodontic visit.";
            }

            // Call Azure OpenAI API
            const openaiUrl = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${DEPLOYMENT_NAME}/chat/completions?api-version=2024-02-15-preview`;
            
            const openaiResponse = await fetch(openaiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': AZURE_OPENAI_KEY
                },
                body: JSON.stringify({
                    messages: [
                        { role: "system", content: systemMessage },
                        { role: "user", content: userMessage }
                    ],
                    max_tokens: 1000,
                    temperature: 0.7
                })
            });

            if (!openaiResponse.ok) {
                const errorText = await openaiResponse.text();
                context.log('Azure OpenAI API Error:', errorText);
                
                return {
                    status: 500,
                    headers: corsHeaders,
                    body: JSON.stringify({
                        success: false,
                        error: `Azure OpenAI API error: ${openaiResponse.status}`
                    })
                };
            }

            const openaiData = await openaiResponse.json();
            const aiResponse = openaiData.choices[0].message.content;

            // Log successful response (without patient data)
            context.log('AI response generated successfully');

            return {
                status: 200,
                headers: corsHeaders,
                body: JSON.stringify({
                    success: true,
                    response: aiResponse
                })
            };

        } catch (error) {
            context.log('Error in chat function:', error);
            
            return {
                status: 500,
                headers: corsHeaders,
                body: JSON.stringify({
                    success: false,
                    error: 'Internal server error'
                })
            };
        }
    }
});
