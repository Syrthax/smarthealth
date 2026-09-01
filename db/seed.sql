INSERT INTO specialties (name, department, sees) VALUES
('Cardiology',       'Heart & Vascular',     'chest discomfort on exertion, palpitations, high blood pressure, high cholesterol, known heart disease follow-up'),
('Neurology',        'Neurosciences',        'headache, migraine, dizziness, fainting, seizures, numbness or tingling, tremor, memory complaints, vision changes that come with headache'),
('Orthopaedics',     'Bone & Joint',         'joint pain, back and neck pain, sports injury, fracture follow-up, swelling or stiffness in limbs'),
('Dermatology',      'Skin & Hair',          'rash, itching, acne, hair loss, nail changes, pigmentation, chronic skin conditions'),
('Gastroenterology', 'Digestive Health',     'abdominal pain, acidity, bloating, vomiting, diarrhoea, constipation, jaundice, appetite or weight loss'),
('Pulmonology',      'Chest & Lung',         'cough lasting weeks, wheezing, breathlessness, asthma, snoring and disturbed sleep, chest infections'),
('ENT',              'Ear, Nose & Throat',   'ear pain, hearing loss, blocked or running nose, sinus pain, sore throat, hoarseness, vertigo'),
('Endocrinology',    'Diabetes & Hormones',  'diabetes, thyroid problems, unexplained weight change, excessive thirst or urination, hormonal irregularity'),
('General Medicine', 'General Medicine',     'fever, fatigue, body ache, infections, urinary burning or frequency, and anything that does not clearly belong to another desk'),
('Ophthalmology',    'Eye Care',             'blurred or double vision, eye pain, redness, watering, eye strain, routine eye examination'),
('Gynaecology',      'Women''s Health',      'menstrual problems, pregnancy care, pelvic pain, menopause, contraception, women''s health screening'),
('Psychiatry',       'Mental Health',        'low mood, anxiety, panic, sleep difficulty, stress, concentration problems, thoughts that feel hard to manage');

INSERT INTO doctors (name, specialty, qualification, department, consult_fee, avail_days, bio) VALUES
('Dr. Anjali Rao',      'Cardiology',       'MD, DM (Cardiology)',        'Heart & Vascular',      900, 'Mon, Tue, Thu', 'Interventional cardiologist. Sees adults for heart rhythm, blood pressure and chest-related concerns.'),
('Dr. Vikram Sethi',    'Cardiology',       'MBBS, MD (Medicine)',        'Heart & Vascular',      750, 'Wed, Fri, Sat', 'Non-invasive cardiology and long-term follow-up for hypertension and cholesterol management.'),
('Dr. Meera Krishnan',  'Neurology',        'MD, DM (Neurology)',         'Neurosciences',        1100, 'Tue, Wed, Fri', 'Headache, seizure and nerve-related consultations for adults.'),
('Dr. Sameer Joshi',    'Orthopaedics',     'MS (Orthopaedics)',          'Bone & Joint',          800, 'Mon, Thu, Sat', 'Joint pain, sports injury and fracture follow-up.'),
('Dr. Farah Qureshi',   'Dermatology',      'MD (Dermatology)',           'Skin & Hair',           700, 'Mon, Wed, Fri', 'Skin, hair and nail consultations including chronic rashes and acne.'),
('Dr. Rohit Nambiar',   'Gastroenterology', 'MD, DM (Gastroenterology)',  'Digestive Health',     1000, 'Tue, Thu, Sat', 'Abdominal, digestive and liver-related consultations.'),
('Dr. Leela Menon',     'Pulmonology',      'MD (Pulmonary Medicine)',    'Chest & Lung',          850, 'Mon, Tue, Fri', 'Breathing difficulty, chronic cough and sleep-related breathing concerns.'),
('Dr. Arjun Patil',     'ENT',              'MS (ENT)',                   'Ear, Nose & Throat',    650, 'Wed, Thu, Sat', 'Ear, nose, throat, sinus and hearing consultations.'),
('Dr. Nisha Bhatt',     'Endocrinology',    'MD, DM (Endocrinology)',     'Diabetes & Hormones',  1000, 'Mon, Wed, Thu', 'Thyroid, diabetes and hormone-related consultations.'),
('Dr. Kabir Desai',     'General Medicine', 'MBBS, MD (Medicine)',        'General Medicine',      500, 'Mon to Sat',    'First point of contact for fever, fatigue, infections and undifferentiated symptoms.'),
('Dr. Ira Chatterjee',  'General Medicine', 'MBBS, MD (Medicine)',        'General Medicine',      500, 'Mon to Fri',    'Adult general medicine, preventive check-ups and referral coordination.'),
('Dr. Suresh Iyer',     'Ophthalmology',    'MS (Ophthalmology)',         'Eye Care',              600, 'Tue, Fri, Sat', 'Vision changes, eye strain and routine eye examinations.'),
('Dr. Priya Venkatesh', 'Gynaecology',      'MS (Obstetrics & Gynae)',    'Women''s Health',       800, 'Mon, Wed, Sat', 'Women''s health, menstrual and antenatal consultations.'),
('Dr. Aditya Kulkarni', 'Psychiatry',       'MD (Psychiatry)',            'Mental Health',         950, 'Tue, Thu, Fri', 'Sleep, mood, stress and anxiety consultations for adults.');

INSERT INTO labs (name, kind, address, phone) VALUES
('Meridian In-House Diagnostics', 'in_house', 'Ground Floor, Block A, Meridian Health City',      '+91 80 4000 1200'),
('Sanjeevani Reference Lab',      'partner',  '14 Residency Road, 2.1 km from Meridian',          '+91 80 4112 9080'),
('PathCore Advanced Imaging',     'partner',  'Sona Tower, Indiranagar, 4.6 km from Meridian',    '+91 80 4277 3311');

INSERT INTO tests (name, code, lab_id, price, prep_notes, turnaround_hours, ordered_for) VALUES
('Complete Blood Count',            'CBC',      1,  350, 'No preparation needed.',                        6, 'fever, fatigue, suspected infection, general screening'),
('Fasting Blood Sugar',             'FBS',      1,  150, 'Fast for 8-10 hours. Water is allowed.',        4, 'blood sugar screening, excessive thirst or urination'),
('HbA1c',                           'HBA1C',    1,  550, 'No fasting needed.',                            8, 'long-term blood sugar control, diabetes follow-up'),
('Lipid Profile',                   'LIPID',    1,  700, 'Fast for 10-12 hours.',                        8, 'cholesterol, cardiac risk assessment'),
('Thyroid Profile (T3, T4, TSH)',   'TFT',      1,  600, 'Morning sample preferred.',                    12, 'thyroid, unexplained weight or energy change, hair loss'),
('Liver Function Test',             'LFT',      1,  750, 'Fast for 8 hours.',                            12, 'liver, jaundice, upper abdominal complaints, alcohol history'),
('Kidney Function Test',            'KFT',      1,  700, 'No preparation needed.',                       12, 'kidney, swelling of feet or face, urinary complaints'),
('Urine Routine & Microscopy',      'URINE-R',  1,  250, 'Midstream sample collected at the lab.',         4, 'burning urination, urinary frequency, suspected urine infection'),
('C-Reactive Protein',              'CRP',      1,  500, 'No preparation needed.',                        6, 'inflammation, unexplained pain or swelling'),
('Erythrocyte Sedimentation Rate',  'ESR',      1,  200, 'No preparation needed.',                        6, 'inflammation, joint pain, prolonged fever'),
('Vitamin D (25-OH)',               'VITD',     1,  1400, 'No preparation needed.',                       24, 'bone and muscle aches, fatigue, frequent fractures'),
('Vitamin B12',                     'VITB12',   1,  1100, 'No preparation needed.',                       24, 'numbness or tingling, fatigue, memory complaints'),
('Electrocardiogram',               'ECG',      1,  400, 'Wear loose clothing. Takes about 10 minutes.',   1, 'palpitations, chest discomfort, irregular heartbeat'),
('Chest X-Ray (PA view)',           'CXR',      1,  550, 'Remove metal jewellery before the scan.',        2, 'cough, chest complaints, breathlessness'),
('Ultrasound Abdomen & Pelvis',     'USG-ABD',  1,  1600, 'Fast for 6 hours. Arrive with a full bladder.', 3, 'abdominal pain, digestive complaints, pelvic complaints'),
('Echocardiogram',                  'ECHO',     1,  2200, 'No preparation needed.',                        4, 'heart murmur, breathlessness on exertion, cardiac follow-up'),
('Pulmonary Function Test',         'PFT',      1,  1500, 'Avoid inhalers for 6 hours if advised.',        3, 'chronic cough, wheezing, breathlessness, asthma follow-up'),
('MRI Brain (plain)',               'MRI-BR',   3,  7500, 'Declare any metal implants or pacemaker.',     48, 'persistent headache, vision changes, neurological complaints, dizziness'),
('CT Coronary Angiography',         'CT-ANGIO', 3,  9800, 'Fast for 4 hours. Arrange someone to accompany you.', 48, 'coronary artery assessment, cardiac follow-up'),
('DEXA Bone Densitometry',          'DEXA',     3,  2800, 'No calcium supplements for 24 hours.',         24, 'bone density, fracture risk, post-menopausal screening'),
('Allergy Panel (IgE, 60 allergens)','IGE-60',  2,  6200, 'Stop antihistamines 72 hours before, if advised.', 72, 'recurrent rash, sneezing, suspected allergy'),
('Sleep Study (Polysomnography)',   'PSG',      2, 11000, 'Overnight study at the partner centre.',       96, 'snoring, daytime sleepiness, disturbed sleep');
