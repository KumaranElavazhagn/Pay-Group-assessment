// Import necessary modules and middleware
const express = require('express');
const bodyParser = require('body-parser');
const { Sequelize } = require('sequelize');
const { Op } = require('sequelize');
const { sequelize } = require('./model');
const { Job, Profile, Contract } = sequelize.models;
const { getProfile } = require('./middleware/getProfile');

// Create an Express application
const app = express();

// Middleware to parse JSON requests
app.use(bodyParser.json());

// Set up Sequelize and models for the application
app.set('sequelize', sequelize);
app.set('models', sequelize.models);

/**
 * GET endpoint to fetch a contract by its ID.
 * Returns the contract if it belongs to the requesting profile.
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models');
    const { id } = req.params;
    const { profile } = req;

    try {
        // Find the contract by ID
        const contract = await Contract.findOne({ where: { id } });

        if (!contract) {
            return res.status(404).json({ error: 'Contract not found' });
        }

        // Check if the contract belongs to the requesting profile
        if (contract.ClientId !== profile.id && contract.ContractorId !== profile.id) {
            return res.status(403).json({ error: 'Unauthorized: Contract does not belong to the requesting profile' });
        }

        res.json(contract);
    } catch (error) {
        console.error('Error fetching contract:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});


/**
 * GET endpoint to fetch contracts belonging to a user (client or contractor).
 * Returns a list of non-terminated contracts associated with the user profile.
 */
app.get('/contracts', getProfile, async (req, res) => {
    // Destructure the Contract model and profile from the request object
    const { Contract } = req.app.get('models');
    const { profile } = req;

    try {
        // Check if profile or profile.id is missing
        if (!profile || !profile.id) {
            return res.status(400).json({ error: 'Profile ID is missing or invalid' });
        }

        // Fetch contracts for the profile (either client or contractor)
        const contracts = await Contract.findAll({
            where: {
                // Find contracts where the profile is either the client or contractor
                [Sequelize.Op.or]: [
                    { ClientId: profile.id },
                    { ContractorId: profile.id }
                ],
                // Exclude contracts with status 'terminated'
                status: { [Sequelize.Op.ne]: 'terminated' }
            }
        });

        res.json(contracts);
    } catch (error) {
        // Handle errors
        console.error('Error fetching contracts:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});


/**
 * GET endpoint to fetch all unpaid jobs for a user (either a client or contractor).
 * Returns unpaid jobs associated with active contracts for the user profile.
 */
app.get('/jobs/unpaid', getProfile, async (req, res) => {
    // Destructure the Job and Contract models and profile from the request object
    const { Job, Contract } = req.app.get('models');
    const { profile } = req;

    try {
        // Find all unpaid jobs associated with active contracts for the user profile
        const unpaidJobs = await Job.findAll({
            where: {
                // Filter unpaid jobs
                paid: null,
                // Filter jobs associated with contracts in progress
                '$Contract.status$': 'in_progress',
                // Filter jobs associated with the user profile (either as client or contractor)
                [Sequelize.Op.or]: [
                    { '$Contract.ClientId$': profile.id },
                    { '$Contract.ContractorId$': profile.id }
                ]
            },
            // Include the Contract model to filter by contract status
            include: [{
                model: Contract,
                as: 'Contract',
                where: {
                    status: 'in_progress'
                }
            }]
        });

        // Respond with the list of unpaid jobs
        res.json(unpaidJobs);
    } catch (error) {
        // Handle errors
        console.error('Error fetching unpaid jobs:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create the endpoint for handling payment for a job
app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
    // Destructure necessary models and objects from req.app
    const { Job, Profile } = req.app.get('models');
    const { profile } = req;
    const jobId = req.params.job_id;

    try {
        // Find the job by its ID and include the associated contract
        const job = await Job.findByPk(jobId, { include: ['Contract'] });

        // Return error if job is not found
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // Ensure the requesting profile is the client associated with this job
        if (job.Contract.ClientId !== profile.id) {
            return res.status(403).json({ error: 'Unauthorized: Only clients can pay for jobs' });
        }

        // Check if the client has enough balance to pay for the job
        if (profile.balance < job.price) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Update balances: deduct from client, add to contractor
        await Profile.update(
            { balance: Sequelize.literal(`balance - ${job.price}`) },
            { where: { id: profile.id } }
        );
        await Profile.update(
            { balance: Sequelize.literal(`balance + ${job.price}`) },
            { where: { id: job.Contract.ContractorId } }
        );

        // Mark the job as paid and set payment date
        await job.update({ paid: true, paymentDate: new Date() });

        // Respond with success message
        res.json({ message: 'Payment successful' });
    } catch (error) {
        // Handle errors
        console.error('Error paying for job:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create the endpoint for depositing money into a client's balance
app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
    // Destructure necessary models and objects from req.app
    const { Profile, Job, Contract } = req.app.get('models');
    const { profile } = req;
    const userId = req.params.userId;

    try {
        // Ensure the requesting profile is a client and matches the userId
        if (profile.id !== parseInt(userId) || profile.type !== 'client') {
            return res.status(403).json({ error: 'Unauthorized: Access denied' });
        }

        // Calculate the total amount of jobs to pay for the client
        const totalJobsToPay = await Job.sum('price', {
            where: {
                // Filter for unpaid jobs associated with the client's active contracts
                paid: null,
                '$Contract.ClientId$': profile.id,
                '$Contract.status$': 'in_progress'
            },
            include: [{
                model: Contract,
                as: 'Contract'
            }]
        });

        // Calculate the maximum amount the client can deposit (25% of total jobs to pay)
        const maxDepositAmount = totalJobsToPay * 0.25;

        // Get the deposit amount from the request body
        const depositAmount = req.body.amount;

        // Check if the deposit amount exceeds the maximum allowed amount
        if (depositAmount > maxDepositAmount) {
            return res.status(400).json({ error: 'Deposit amount exceeds maximum allowed' });
        }

        // Update the client's balance
        await Profile.update(
            { balance: Sequelize.literal(`balance + ${depositAmount}`) },
            { where: { id: profile.id } }
        );

        // Respond with success message
        res.json({ message: 'Deposit successful' });
    } catch (error) {
        // Handle errors
        console.error('Error depositing money:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/best-profession?start=<date>&end=<date>
app.get('/admin/best-profession', async (req, res) => {
    // Extracting start and end dates from the query parameters
    const { start, end } = req.query;

    try {
        // Find the profession that earned the most money within the specified date range
        const bestProfession = await Job.findAll({
            // Selecting attributes to include in the result
            attributes: ['Contract.Contractor.profession', [sequelize.fn('sum', sequelize.col('price')), 'totalEarned']],
            include: [{
                // Including the Contract model
                model: Contract,
                as: 'Contract',
                attributes: [],
                where: {
                    // Filtering contracts that are in progress and within the specified date range
                    status: 'in_progress',
                    createdAt: {
                        [Op.between]: [start, end]
                    }
                },
                include: [{
                    // Including the Profile model (Contractor)
                    model: Profile,
                    as: 'Contractor',
                    attributes: [],
                    where: { type: 'contractor' } // Filtering only contractors
                }]
            }],
            // Grouping the result by Contractor's profession
            group: ['Contract.Contractor.profession'],
            // Ordering the result by totalEarned in descending order
            order: [[sequelize.literal('totalEarned'), 'DESC']],
            // Limiting the result to 1 entry
            limit: 1
        });

        // Sending the result as JSON response
        res.json(bestProfession);
    } catch (error) {
        // Handling errors
        console.error('Error best-profession', error.message);
        res.status(500).json({ message: 'Internal server error' });
    }
});



// GET /admin/best-clients?start=<date>&end=<date>&limit=<integer>
app.get('/admin/best-clients', async (req, res) => {
    // Extracting start, end, and limit from the query parameters
    const { start, end, limit = 2 } = req.query;

    try {
        // Finding the best clients based on the total amount paid for jobs within the specified date range
        const bestClients = await Job.findAll({
            // Selecting attributes to include in the result
            attributes: [
                [sequelize.fn('SUM', sequelize.col('price')), 'totalPaid'], // Calculating the total amount paid
                [sequelize.literal('Contract.ClientId'), 'id'], // Selecting the client ID
                [sequelize.literal('`Contract->Client`.`firstName` || " " || `Contract->Client`.`lastName`'), 'fullName'] // Concatenating first name and last name to get the full name
            ],
            include: [{
                // Including the Contract model
                model: Contract,
                as: 'Contract',
                attributes: [],
                where: {
                    // Filtering contracts that are in progress and within the specified date range
                    status: 'in_progress',
                    createdAt: {
                        [Op.between]: [start, end]
                    }
                },
                include: [{
                    // Including the Profile model (Client)
                    model: Profile,
                    as: 'Client',
                    attributes: [] // No attributes needed for the Client
                }]
            }],
            // Grouping the result by Client ID
            group: ['Contract.ClientId'],
            // Ordering the result by totalPaid in descending order
            order: [[sequelize.literal('totalPaid'), 'DESC']],
            // Limiting the result to the specified number of clients
            limit: parseInt(limit)
        });

        // Formatting the result to include only the necessary fields
        res.json(bestClients.map(job => ({
            id: job.dataValues.id, // Client ID
            fullName: job.dataValues.fullName, // Full name of the client
            totalPaid: job.dataValues.totalPaid // Total amount paid by the client
        })));
    } catch (error) {
        // Handling errors
        console.error('Error best-clients', error.message);
        res.status(500).json({ message: 'Internal server error' });
    }
});



module.exports = app;
