const express = require('express');
const cors = require('cors');
const { Sequelize, DataTypes, Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
require('dotenv').config();
const twilio = require('twilio');
const app = express();
const TWILIO_ACCOUNT_SID= process.env.TWILIO_ACCOUNT_SID
const TWILIO_AUTH_TOKEN = process.env.TWILIO_ACCOUNT_TOKEN
const TWILIO_PHONE_NUMBER =process.env.TWILIO_PHONE_NUMBER

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);



// Sequelize setup
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'mysql',
 
});

const allowedOrigins = [
  process.env.LOCAL_FRONTEND,
  process.env.LIVE_FRONTEND1,
  process.env.LIVE_FRONTEND2 // Add your new domain here
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // allow requests with no origin (like curl, mobile apps)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log(`❌ Blocked by CORS: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
// app.options('*', cors(corsOptions)); // Enable preflight for all routes
app.use(express.json());



app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});

 
//Shareholder Model
const Shareholder = sequelize.define('shareholders', {
  acno: { type: DataTypes.STRING, allowNull: false, primaryKey: true },
  name: DataTypes.STRING,
 
  address: DataTypes.STRING,
  holdings: DataTypes.STRING,
  phone_number: DataTypes.STRING,
  email: DataTypes.STRING,
  chn: { type:Sequelize.STRING, allowNull: true },
  rin: DataTypes.STRING,
  hasVoted: { type: Sequelize.BOOLEAN, defaultValue: false, allowNull: false }
}, {
  timestamps: false,
  freezTableName: true
});

// Registered User Model
const RegisteredUser = sequelize.define('registeredusers', {
  name: DataTypes.STRING,
  acno: DataTypes.STRING,
  holdings: DataTypes.STRING,
  email: DataTypes.STRING,
  phone_number: DataTypes.STRING,
 chn: { type:Sequelize.STRING, allowNull: true },
  registered_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  
});

// Verification Token Model
const VerificationToken = sequelize.define('VerificationToken', {
  acno: { type: DataTypes.STRING, allowNull: false },
  token: { type: DataTypes.STRING, allowNull: false },
  email: DataTypes.STRING,
  phone_number: DataTypes.STRING,
  chn: { type:Sequelize.STRING, allowNull: true },
  expires_at: { type: DataTypes.DATE, allowNull: false }
}, {
  timestamps: false,
  freezeTableName: true
});

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});





// Updated check-shareholder route
app.post('/api/check-shareholder', async (req, res) => {
  const { searchTerm } = req.body;

  if (!searchTerm) {
    return res.status(400).json({ error: 'Please provide a search term.' });
  }

  try {
    // Check if searchTerm is numeric (account number)
    const isAccountNumber = /^\d+$/.test(searchTerm);

    if (isAccountNumber) {
      // Exact match for account numbers
      const shareholder = await Shareholder.findOne({ 
        where: { acno: searchTerm  } 
      });

      if (shareholder) {
        return res.json({
          status: 'account_match',
          shareholder: {
            name: shareholder.name,
            acno: shareholder.acno,
            email: shareholder.email,
            phone_number: shareholder.phone_number,
            chn:shareholder.chn
          }
        });
      }
    }
    const byChn = await Shareholder.findOne({ where: { chn: searchTerm } });
    if (byChn) {
      return res.json({
        status: 'chn_match',
        shareholder: {
          name: byChn.name,
          acno: byChn.acno,
          email: byChn.email,
          phone_number: byChn.phone_number,
          chn: byChn.chn
        }
      });
    }

    // For names, do partial search (randomized)
   const shareholders = await Shareholder.findAll({
  where: {
    [Op.or]: [
      // Basic search
      { name: { [Op.like]: `%${searchTerm}%` } },
      
      // Split search term into words and search for each component
      ...searchTerm.split(/\s+/).filter(Boolean).map(word => ({
        name: { [Op.like]: `%${word}%` }
      })),
      
      // Soundex for phonetic matching (handles some misspellings)
      sequelize.where(
        sequelize.fn('SOUNDEX', sequelize.col('name')),
        'LIKE',
        `${sequelize.fn('SOUNDEX', searchTerm)}%`
      ),
      
      // Levenshtein distance for typo tolerance (if extension is available)
      ...(sequelize.dialect === 'mysql' ? [{
        name: sequelize.where(
          sequelize.fn('LEVENSHTEIN', 
            sequelize.fn('LOWER', sequelize.col('name')),
            sequelize.fn('LOWER', searchTerm)
          ),
          { [Op.lte]: 3 } // Allow small differences
        )
      }] : [])
    ]
  },
  order: [
    // Prioritize exact matches first
    sequelize.literal(`CASE WHEN name LIKE '${searchTerm}' THEN 0 
                        WHEN name LIKE '${searchTerm}%' THEN 1 
                        WHEN name LIKE '%${searchTerm}%' THEN 2 
                        ELSE 3 END`),
    // Then sort by random for equally good matches
    sequelize.random()
  ],
  limit: 10
});

    if (shareholders.length > 0) {
      return res.json({
        status: 'name_matches',
        shareholders: shareholders.map(sh => ({
          name: sh.name,
          acno: sh.acno,
          email: sh.email,
          phone_number: sh.phone_number,
          chn: sh.chn
        }))
      });
    }

    return res.json({ 
      status: 'not_found', 
      message: 'No matching shareholders found.' 
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// Send confirmation link via email
app.post('/api/send-confirmation', async (req, res) => {
  const { acno, email, phone_number } = req.body;


  try {

    const alreadyRegistered = await RegisteredUser.findOne({
      where: 
  
          { acno }
        
      
    });

    if (alreadyRegistered) {
      return res.status(400).json({ message: '❌ This shareholder is already registered with the same ACNO, Email, Phone Number or CHN.' });
    }

    const shareholder = await Shareholder.findOne({ where: { acno } });
    if (!shareholder) return res.status(404).json({ message: 'Shareholder not found' });



if (email && email !== shareholder.email) {
      await Shareholder.update(
        { email },
        { where: { acno } }
      );
      shareholder.email = email; // Update local instance
    }

    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await VerificationToken.create({ acno, token, email, phone_number, expires_at: expiresAt });

    const confirmUrl = `https://e-voting-backeknd-production.up.railway.app/api/confirm/${token}`;

    await transporter.sendMail({
      from: 'E-Registration <your@email.com>',
      to: shareholder.email,
      subject: 'Confirm Your Registration',
      html: `
        <h2>🗳️ E-Voting Registration</h2>
        <p>Hello ${shareholder.name},</p>
        <p>Click the button below to confirm your registration:</p>
        <a href="${confirmUrl}" style="background-color:#1075bf;padding:12px 20px;color:#fff;text-decoration:none;border-radius:5px;">
          ✅ Confirm Registration
        </a>
        <p>If you didn’t request this, just ignore this email.</p>
      `
    });

        // Send SMS if phone number exists
    if (phone_number) {
      try {
        await twilioClient.messages.create({
          body: `Hello ${shareholder.name}, confirm your SAHCO AGM registration: ${confirmUrl}`,
          from: TWILIO_PHONE_NUMBER,
          to: phone_number
        });
      } catch (smsError) {
        console.error('Failed to send SMS:', smsError);
        // Don't fail the whole request if SMS fails
      }
    }

    res.json({ message: '✅ Confirmation sent to email and phone' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send confirmation.' });
  }
});

// Confirm registration
app.get('/api/confirm/:token', async (req, res) => {
  const { token } = req.params;

  try {
    const pending = await VerificationToken.findOne({ where: { token } });

    if (!pending || new Date(pending.expires_at) < new Date()) {
      return res.status(400).send('❌ Invalid or expired token.');
    }

    // Fetch full shareholder details
    const shareholder = await Shareholder.findOne({ where: { acno: pending.acno } });

    if (!shareholder) {
      return res.status(404).send('❌ Shareholder not found.');
    }

    await RegisteredUser.create({
      name: shareholder.name,
      acno: shareholder.acno,
      email: shareholder.email,
      phone_number: shareholder.phone_number,
      registered_at: new Date(),
      holdings: shareholder.holdings,
      chn:shareholder.chn
    });

    await pending.destroy();


    // Add this endpoint to your existing server code


    // Send follow-up email
    await transporter.sendMail({
      from: '"E-Voting Portal" <your@email.com>',
      to: shareholder.email,
      subject: '✅ Successfully Registered for SAHCO AGM',
      html: `
        <h2>🎉 Hello ${shareholder.name},</h2>
        <p>You have successfully registered for the upcoming SAHcO Annual General Meeting.</p>
        <p>✅ Your account is now active.</p>
        <h3>🗳️ Voting Instructions:</h3>
        <ul>
          <li>You will recieve a zoom link on you mail to join the Annual General meeting </a></li>
          <li>Login to zoom using only your registered email address: <strong>${shareholder.email}</strong>
   
        </ul>
        <p>Thank you for participating!</p>
      `
    });


      // Send success SMS if phone number exists
    if (shareholder.phone_number) {
      try {
        await twilioClient.messages.create({
          body: `Hello ${shareholder.name}, your SAHCO AGM registration is successful. You will receive Zoom details via email.`,
          from: TWILIO_PHONE_NUMBER,
          to: shareholder.phone_number
        });
      } catch (smsError) {
        console.error('Failed to send success SMS:', smsError);
      }
    }

    res.redirect('https://agm-registration.apel.com.ng//registration-success');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});
// Get all registered users with pagination
app.get('/api/registered-users', async (req, res) => {
  try {
    // Pagination parameters
    const page = parseInt(req.query.page) || 1; // Default to page 1
    const pageSize = parseInt(req.query.pageSize) || 10; // Default to 10 items per page
    const offset = (page - 1) * pageSize;

    // Sorting parameters
    const sortBy = req.query.sortBy || 'registered_at'; // Default sort by registration date
    const sortOrder = req.query.sortOrder || 'DESC'; // Default descending order

    // Search filter
    const searchTerm = req.query.search || '';

    // Build the query conditions
    const whereConditions = {};
    if (searchTerm) {
      whereConditions[Op.or] = [
        { name: { [Op.like]: `%${searchTerm}%` } },
        { acno: { [Op.like]: `%${searchTerm}%` } },
        { email: { [Op.like]: `%${searchTerm}%` } },
        { phone_number: { [Op.like]: `%${searchTerm}%` } },
        { chn: { [Op.like]: `%${searchTerm}%` } }
      ];
    }

    // Get the total count for pagination info
    const totalCount = await RegisteredUser.count({ where: whereConditions });

    // Get the paginated results
    const users = await RegisteredUser.findAll({
      where: whereConditions,
      order: [[sortBy, sortOrder]],
      limit: pageSize,
      offset: offset,
      attributes: ['name', 'acno', 'email', 'phone_number', 'holdings','chn', 'registered_at'] // Select specific fields
    });

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / pageSize);

    res.json({
      success: true,
      data: users,
      pagination: {
        totalItems: totalCount,
        totalPages,
        currentPage: page,
        pageSize,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching registered users:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch registered users',
      error: error.message
    });
  }
});
// Start server
const PORT = process.env.PORT;
sequelize.sync().then(() => {
  console.log('✅ Database synced');
  app.listen(PORT, () => {
    console.log(`🚀 Server running on ${PORT}`);
  });
});
