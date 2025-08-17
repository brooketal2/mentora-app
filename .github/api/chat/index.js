const { app } = require('@azure/functions');

app.http('chat', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'chat',
    handler: async (request, context) => {
        context.log('Processing chat request');

        // CORS headers
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': 'application/json'
        };

        // Handle OPTIONS request for CORS
        if (request.method === 'OPTIONS') {
            return {
                status: 200,
                headers: headers
            };
        }

        try {
            // Get request body
            let requestData = {};
            if (request.method === 'POST') {
                const requestText = await request.text();
                requestData = JSON.parse(requestText);
            }

            const { message, action } = requestData;

            // Get environment variables
            const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
            const apiKey = process.env.AZURE_OPENAI_KEY;
            const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

            if (!endpoint || !apiKey || !deployment) {
                throw new Error('Missing Azure OpenAI configuration. Please check environment variables.');
            }

            // Patient context
            const patientContext = `
            Patient: Albert Zagg
            Age: 14, DOB: 1/1/2011
            Treatment: Upper + Lower Braces (0.022" MBT)
            Current Wire: 18x18 NiTi BIO (in for 7 weeks)
            Progress: 4/24 months (17% complete)
            Diagnosis: Skeletal Class II, Dental Class I
            Compliance: Good
            Current Elastics: Anterior box elastics (UL2-UR2 to LL2-LR2)
            `;

            // Prepare messages for OpenAI
            let messages = [];
            
            if (action === 'generateNote') {
                messages = [
                    {
                        role: 'system',
                        content: `You are a clinical AI assistant for orthodontic practice. Generate professional clinical notes for EHR documentation. Patient info:\n\n${patientContext}`
                    },
                    {
                        role: 'user',
                        content: 'Generate a comprehensive clinical note for today\'s orthodontic visit.'
                    }
                ];
            } else {
                messages = [
                    {
                        role: 'system',
                        content: `You are a clinical AI assistant for orthodontic practice. Patient info:\n\n${patientContext}\n\nProvide helpful, professional responses about orthodontic treatment.`
                    },
                    {
                        role: 'user',
                        content: message || 'Hello, how can you help me today?'
                    }
                ];
            }

            // Call Azure OpenAI
            const openaiUrl = `${endpoint}openai/deployments/${deployment}/chat/completions?api-version=2024-02-15-preview`;
            
            const openaiResponse = await fetch(openaiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': apiKey
                },
                body: JSON.stringify({
                    messages: messages,
                    max_tokens: action === 'generateNote' ? 800 : 500,
                    temperature: 0.7
                })
            });

            if (!openaiResponse.ok) {
                const errorText = await openaiResponse.text();
                context.log.error('OpenAI API error:', errorText);
                throw new Error(`OpenAI API error: ${openaiResponse.status}`);
            }

            const data = await openaiResponse.json();
            const aiResponse = data.choices[0].message.content;

            return {
                status: 200,
                headers: headers,
                body: JSON.stringify({
                    success: true,
                    response: aiResponse,
                    timestamp: new Date().toISOString()
                })
            };

        } catch (error) {
            context.log.error('Error in chat function:', error);
            
            return {
                status: 500,
                headers: headers,
                body: JSON.stringify({
                    success: false,
                    error: error.message || 'Internal server error',
                    timestamp: new Date().toISOString()
                })
            };
        }
    }
});
