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



// Add this phone number formatter function
function formatNigerianPhone(phone) {
  // Remove all non-digit characters
  let cleaned = phone.replace(/\D/g, '');

  // Convert local numbers (starts with 0)
  if (cleaned.startsWith('0')) {
    return `+234${cleaned.substring(1)}`;
  }

  // Convert already national numbers (without +234)
  if (cleaned.startsWith('234') && cleaned.length === 13) {
    return `+${cleaned}`;
  }

  // Return as-is if already international format
  return phone;
}



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

  // Phone number formatting and validation functions
  const formatNigerianPhone = (phone) => {
    if (!phone) return null;
    try {
      const phoneString = String(phone).trim();
      let cleaned = phoneString.replace(/\D/g, '');
      
      if (cleaned.startsWith('0')) {
        return `+234${cleaned.substring(1)}`;
      }
      if (cleaned.startsWith('234') && cleaned.length === 13) {
        return `+${cleaned}`;
      }
      return phoneString;
    } catch (error) {
      console.error('Phone formatting error:', error);
      return null;
    }
  };

  const isValidNigerianPhone = (phone) => {
    return phone && /^\+234[789]\d{9}$/.test(String(phone).trim());
  };

  try {
    // Check if already registered
    const alreadyRegistered = await RegisteredUser.findOne({ where: { acno } });
    if (alreadyRegistered) {
      return res.status(400).json({ 
        message: '❌ This shareholder is already registered',
        details: { acno }
      });
    }

    // Find shareholder
    const shareholder = await Shareholder.findOne({ where: { acno } });
    if (!shareholder) {
      return res.status(404).json({ 
        message: 'Shareholder not found',
        details: { acno }
      });
    }

    // Update email if provided and different
    if (email && email !== shareholder.email) {
      await Shareholder.update({ email }, { where: { acno } });
      shareholder.email = email;
    }

    // Generate verification token
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes expiry

    await VerificationToken.create({ 
      acno, 
      token, 
      email: shareholder.email, 
      phone_number: shareholder.phone_number, 
      expires_at: expiresAt 
    });

    const confirmUrl = `https://e-voting-backeknd-production.up.railway.app/api/confirm/${token}`;

    // Send confirmation email
    await transporter.sendMail({
      from: 'E-Registration <noreply@agm-registration.apel.com.ng>',
      to: shareholder.email,
      subject: 'Confirm Your Registration',
      html: `
        <h2>🗳️ E-Voting Registration</h2>
        <p>Hello ${shareholder.name},</p>
        <p>Click the button below to confirm your registration:</p>
        <a href="${confirmUrl}" style="background-color:#1075bf;padding:12px 20px;color:#fff;text-decoration:none;border-radius:5px;">
          ✅ Confirm Registration
        </a>
        <p>If you didn't request this, please ignore this email.</p>
        <p><small>Token expires at: ${expiresAt.toLocaleString()}</small></p>
      `
    });

    // Send SMS if phone number exists
    if (shareholder.phone_number) {
      try {
        const formattedPhone = formatNigerianPhone(shareholder.phone_number);
        
        if (formattedPhone && isValidNigerianPhone(formattedPhone)) {
          await twilioClient.messages.create({
            body: `Hello ${shareholder.name}, confirm SAHCO AGM registration: ${confirmUrl}`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: formattedPhone
          });
          console.log(`SMS sent to ${formattedPhone}`);
        } else {
          console.warn('Invalid phone number format:', shareholder.phone_number);
        }
      } catch (smsError) {
        console.error('SMS sending failed:', {
          error: smsError.message,
          phone: shareholder.phone_number,
          timestamp: new Date().toISOString()
        });
      }
    }

    res.json({ 
      success: true,
      message: '✅ Confirmation sent to your email',
      details: {
        email: shareholder.email,
        phone_number: shareholder.phone_number ? 'SMS sent' : 'No phone number'
      }
    });

  } catch (error) {
    console.error('Send confirmation error:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      requestBody: req.body
    });
    res.status(500).json({ 
      success: false,
      error: 'Failed to send confirmation',
      details: error.message 
    });
  }
});

// Confirm registration
app.get('/api/confirm/:token', async (req, res) => {
  const { token } = req.params;

  // Reusable phone functions
  const formatNigerianPhone = (phone) => {
    if (!phone) return null;
    try {
      const phoneString = String(phone).trim();
      let cleaned = phoneString.replace(/\D/g, '');
      
      if (cleaned.startsWith('0')) {
        return `+234${cleaned.substring(1)}`;
      }
      if (cleaned.startsWith('234') && cleaned.length === 13) {
        return `+${cleaned}`;
      }
      return phoneString;
    } catch (error) {
      console.error('Phone formatting error:', error);
      return null;
    }
  };

  const isValidNigerianPhone = (phone) => {
    return phone && /^\+234[789]\d{9}$/.test(String(phone).trim());
  };

  try {
    // Verify token
    const pending = await VerificationToken.findOne({ where: { token } });
    if (!pending || new Date(pending.expires_at) < new Date()) {
      return res.status(400).send(`
        <h1>❌ Invalid or Expired Token</h1>
        <p>The confirmation link has expired or is invalid.</p>
        <p>Please request a new confirmation email.</p>
      `);
    }

    // Get shareholder data
    const shareholder = await Shareholder.findOne({ where: { acno: pending.acno } });
    if (!shareholder) {
      return res.status(404).send(`
        <h1>❌ Shareholder Not Found</h1>
        <p>We couldn't find your shareholder record.</p>
        <p>Please contact support with your ACNO: ${pending.acno}</p>
      `);
    }

    // Complete registration
    await RegisteredUser.create({
      name: shareholder.name,
      acno: shareholder.acno,
      email: shareholder.email,
      phone_number: shareholder.phone_number,
      registered_at: new Date(),
      holdings: shareholder.holdings,
      chn: shareholder.chn
    });

    await pending.destroy();

    // Send success notifications
    const mailPromise = transporter.sendMail({
      from: '"E-Voting Portal" <noreply@agm-registration.apel.com.ng>',
      to: shareholder.email,
      subject: '✅ Registration Complete - SAHCO AGM',
      html: `
        <h2>🎉 Hello ${shareholder.name},</h2>
        <p>Your registration for the SAHCO Annual General Meeting is complete.</p>
        <p><strong>ACNO:</strong> ${shareholder.acno}</p>
        <p><strong>Registered Email:</strong> ${shareholder.email}</p>
        <h3>Next Steps:</h3>
        <ul>
          <li>You will receive Zoom meeting details 24 hours before the AGM</li>
          <li>Login using your registered email: <strong>${shareholder.email}</strong></li>
        </ul>
        <p>Thank you for participating!</p>
      `
    });

    let smsSuccess = false;
    if (shareholder.phone_number) {
      try {
        const formattedPhone = formatNigerianPhone(shareholder.phone_number);
        if (formattedPhone && isValidNigerianPhone(formattedPhone)) {
          await twilioClient.messages.create({
            body: `Hello ${shareholder.name}, your SAHCO AGM registration (ACNO: ${shareholder.acno}) is complete. A Zoom meeting link will be sent to you before the AGM.`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: formattedPhone
          });
          smsSuccess = true;
        }
      } catch (smsError) {
        console.error('Confirmation SMS failed:', smsError.message);
      }
    }

    await mailPromise; // Ensure email is sent before redirecting

    // Custom success page with details
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Registration Successful</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 2rem; }
          .success { color: #2ecc71; font-size: 2rem; }
          .details { background: #f8f9fa; padding: 1rem; border-radius: 5px; max-width: 600px; margin: 1rem auto; }
        </style>
      </head>
      <body>
        <div class="success">✅ Registration Successful</div>
        <div class="details">
          <h2>Hello ${shareholder.name}</h2>
          <p>Your registration for the SAHCO AGM is complete.</p>
          <p><strong>ACNO:</strong> ${shareholder.acno}</p>
          <p><strong>Email:</strong> ${shareholder.email}</p>
          <p>${smsSuccess ? '📱 An SMS confirmation has been sent to your phone.' : ''}</p>
          <p>You will receive meeting details via email before the event.</p>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Confirmation error:', {
      error: error.message,
      stack: error.stack,
      token,
      timestamp: new Date().toISOString()
    });
    res.status(500).send(`
      <h1>⚠️ Server Error</h1>
      <p>We encountered an error processing your registration.</p>
      <p>Please try again later or contact support.</p>
    `);
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
