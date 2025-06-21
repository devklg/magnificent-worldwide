// ==================== ELENA'S COMPLETE POWERLINE API ENDPOINTS ====================
// Additional endpoints to complete Elena's backend API deliverables

// ==================== POWERLINE POSITION ROUTES ====================

// Get member's PowerLine position and tree data
app.get('/api/powerline/position', authenticateToken, async (req, res) => {
  try {
    const position = await PowerLinePosition.findOne({
      'occupant.promoterId': req.user.promoterId
    }).populate('occupant.promoterId', 'personalInfo.firstName personalInfo.lastName');

    if (!position) {
      return res.status(404).json({ error: 'PowerLine position not found' });
    }

    // Get team statistics
    const leftTeamPositions = await PowerLinePosition.find({
      'position.path': { $regex: `^${position.position.path}L` }
    });

    const rightTeamPositions = await PowerLinePosition.find({
      'position.path': { $regex: `^${position.position.path}R` }
    });

    const teamStats = {
      leftTeam: {
        count: leftTeamPositions.length,
        volume: leftTeamPositions.reduce((sum, pos) => sum + pos.volume.personalVolume, 0),
        activeCount: leftTeamPositions.filter(pos => pos.occupant.isActive).length
      },
      rightTeam: {
        count: rightTeamPositions.length,
        volume: rightTeamPositions.reduce((sum, pos) => sum + pos.volume.personalVolume, 0),
        activeCount: rightTeamPositions.filter(pos => pos.occupant.isActive).length
      }
    };

    res.json({
      position: {
        nodeId: position.position.nodeId,
        level: position.position.level,
        positionNumber: position.position.positionNumber,
        side: position.position.side
      },
      volume: position.volume,
      performance: position.performance,
      teamStats,
      binaryQualification: position.binaryQualification
    });

  } catch (error) {
    console.error('Get PowerLine position error:', error);
    res.status(500).json({ error: 'Failed to retrieve PowerLine position' });
  }
});

// Get PowerLine tree visualization data
app.get('/api/powerline/tree/:levels?', authenticateToken, async (req, res) => {
  try {
    const maxLevels = parseInt(req.params.levels) || 5;
    
    // Find the user's position
    const userPosition = await PowerLinePosition.findOne({
      'occupant.promoterId': req.user.promoterId
    });

    if (!userPosition) {
      return res.status(404).json({ error: 'Position not found' });
    }

    // Get tree data starting from user's position
    const treeData = await PowerLinePosition.getTreeVisualization(
      userPosition.position.nodeId, 
      maxLevels
    );

    res.json({
      rootPosition: userPosition.position.nodeId,
      maxLevels,
      treeData,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get PowerLine tree error:', error);
    res.status(500).json({ error: 'Failed to retrieve PowerLine tree' });
  }
});

// Submit prospect to PowerLine with automatic placement
app.post('/api/powerline/submit-prospect', authenticateToken, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, notes, preferredSide } = req.body;

    // Create the prospect first
    const prospect = new Prospect({
      basicInfo: {
        firstName,
        lastName,
        email,
        phone
      },
      assignment: {
        assignedPromoter: req.user.promoterId,
        assignmentMethod: 'Direct'
      },
      source: {
        landingPage: 'powerline_submission',
        utmSource: 'direct'
      },
      metadata: {
        createdBy: req.user.promoterId
      }
    });

    await prospect.save();

    // Find optimal placement position
    const availablePositions = await PowerLinePosition.findAvailableSpilloverPositions(10);
    
    let targetPosition;
    if (preferredSide && availablePositions.length > 0) {
      // Try to honor preferred side
      targetPosition = availablePositions.find(pos => 
        pos.position.side === preferredSide || 
        !pos.treeStructure.leftChildNodeId || 
        !pos.treeStructure.rightChildNodeId
      );
    } else {
      targetPosition = availablePositions[0];
    }

    if (!targetPosition) {
      return res.status(400).json({ error: 'No available positions in PowerLine' });
    }

    // Calculate placement side
    const placementSide = (!targetPosition.treeStructure.leftChildNodeId) ? 'Left' : 'Right';

    // Create PowerLine position for prospect
    const newPosition = new PowerLinePosition({
      position: {
        nodeId: `${targetPosition.position.nodeId}_${placementSide}`,
        level: targetPosition.position.level + 1,
        positionNumber: await PowerLinePosition.countDocuments() + 1,
        path: PowerLinePosition.buildTreePath(targetPosition.position.path, placementSide),
        side: placementSide
      },
      treeStructure: {
        parentNodeId: targetPosition.position.nodeId
      },
      occupant: {
        promoterId: null, // Prospect not yet enrolled
        placementMethod: 'Spillover'
      },
      metadata: {
        prospectId: prospect._id,
        submittedBy: req.user.promoterId
      }
    });

    await newPosition.save();

    // Update parent position
    const updateField = placementSide === 'Left' ? 'leftChildNodeId' : 'rightChildNodeId';
    await PowerLinePosition.findByIdAndUpdate(targetPosition._id, {
      [`treeStructure.${updateField}`]: newPosition.position.nodeId,
      'treeStructure.isLeaf': false
    });

    res.status(201).json({
      message: 'Prospect submitted and positioned successfully',
      prospect: {
        id: prospect._id,
        name: `${firstName} ${lastName}`,
        email
      },
      powerlinePosition: {
        nodeId: newPosition.position.nodeId,
        level: newPosition.position.level,
        side: placementSide,
        parentNodeId: targetPosition.position.nodeId
      }
    });

  } catch (error) {
    console.error('Submit prospect to PowerLine error:', error);
    res.status(500).json({ error: 'Failed to submit prospect to PowerLine' });
  }
});

// ==================== COMMISSION TRACKING ROUTES ====================

// Get member's commission history
app.get('/api/commissions', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, type, startDate, endDate } = req.query;
    
    const filter = { 'participants.recipient': req.user.promoterId };
    
    if (type) filter['transaction.commissionType'] = type;
    if (startDate || endDate) {
      filter['orderDetails.orderDate'] = {};
      if (startDate) filter['orderDetails.orderDate'].$gte = new Date(startDate);
      if (endDate) filter['orderDetails.orderDate'].$lte = new Date(endDate);
    }

    const commissions = await Commission.find(filter)
      .sort({ 'metadata.createdAt': -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .populate('participants.recipient', 'personalInfo.firstName personalInfo.lastName');

    const totalCommissions = await Commission.countDocuments(filter);
    
    // Calculate summary statistics
    const summary = await Commission.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$transaction.amount' },
          totalCount: { $sum: 1 },
          averageAmount: { $avg: '$transaction.amount' },
          thisWeekAmount: {
            $sum: {
              $cond: [
                { $gte: ['$metadata.createdAt', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)] },
                '$transaction.amount',
                0
              ]
            }
          }
        }
      }
    ]);

    res.json({
      commissions,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCommissions / limit),
        totalCommissions
      },
      summary: summary[0] || {
        totalAmount: 0,
        totalCount: 0,
        averageAmount: 0,
        thisWeekAmount: 0
      }
    });

  } catch (error) {
    console.error('Get commissions error:', error);
    res.status(500).json({ error: 'Failed to retrieve commissions' });
  }
});

// Get real-time commission feed for dashboard
app.get('/api/commissions/feed', authenticateToken, async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const recentCommissions = await Commission.getRealTimeFeed(limit);

    const formattedFeed = recentCommissions.map(commission => ({
      id: commission._id,
      amount: commission.formattedAmount,
      type: commission.transaction.commissionType,
      earner: commission.displayName,
      location: commission.realTimeFeed.location?.displayLocation,
      timestamp: commission.metadata.createdAt,
      celebration: commission.realTimeFeed.celebrationType,
      impactScore: commission.analytics.impactScore
    }));

    res.json({
      feed: formattedFeed,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get commission feed error:', error);
    res.status(500).json({ error: 'Failed to retrieve commission feed' });
  }
});

// Calculate potential earnings based on PowerLine position
app.get('/api/commissions/potential', authenticateToken, async (req, res) => {
  try {
    const position = await PowerLinePosition.findOne({
      'occupant.promoterId': req.user.promoterId
    });

    if (!position) {
      return res.status(404).json({ error: 'PowerLine position not found' });
    }

    // Calculate cycle earnings
    const cycleResults = position.calculateCycleEarnings();
    
    // Project future earnings based on team growth
    const projections = {
      nextCycle: cycleResults.earnings,
      next30Days: cycleResults.earnings * 4.3, // Approximate monthly
      next90Days: cycleResults.earnings * 13,   // Quarterly projection
      withDoubleTeam: position.volume.lesserLegVolume * 2 * 0.1 // If team doubles
    };

    res.json({
      currentCycle: cycleResults,
      projections,
      teamBalance: {
        leftLeg: position.volume.leftLegVolume,
        rightLeg: position.volume.rightLegVolume,
        balanceRatio: position.performance.balanceRatio
      },
      recommendations: [
        position.volume.leftLegVolume < position.volume.rightLegVolume ? 
          'Focus on building your left team to increase cycle frequency' :
          'Focus on building your right team to increase cycle frequency',
        `You need $${(500 - (position.volume.lesserLegVolume % 500)).toLocaleString()} more volume in your smaller leg for the next cycle`
      ]
    });

  } catch (error) {
    console.error('Calculate potential earnings error:', error);
    res.status(500).json({ error: 'Failed to calculate potential earnings' });
  }
});

// ==================== TEAM HIERARCHY ROUTES ====================

// Get team hierarchy and genealogy
app.get('/api/team/hierarchy', authenticateToken, async (req, res) => {
  try {
    const { levels = 5, direction = 'down' } = req.query;

    const userPosition = await PowerLinePosition.findOne({
      'occupant.promoterId': req.user.promoterId
    }).populate('occupant.promoterId', 'personalInfo');

    if (!userPosition) {
      return res.status(404).json({ error: 'Position not found' });
    }

    let hierarchy = {};

    if (direction === 'down' || direction === 'both') {
      // Get downline (team members below)
      const downlineQuery = {
        'position.level': { 
          $gt: userPosition.position.level,
          $lte: userPosition.position.level + parseInt(levels)
        },
        'position.path': { $regex: `^${userPosition.position.path}` }
      };

      const downline = await PowerLinePosition.find(downlineQuery)
        .populate('occupant.promoterId', 'personalInfo.firstName personalInfo.lastName')
        .sort('position.level position.positionNumber');

      hierarchy.downline = downline.map(pos => ({
        nodeId: pos.position.nodeId,
        level: pos.position.level,
        side: pos.position.side,
        member: pos.occupant.promoterId ? {
          name: `${pos.occupant.promoterId.personalInfo.firstName} ${pos.occupant.promoterId.personalInfo.lastName}`,
          joinDate: pos.occupant.placementDate,
          isActive: pos.occupant.isActive
        } : null,
        volume: pos.volume.personalVolume,
        teamSize: pos.treeStructure.subtreeSize
      }));
    }

    if (direction === 'up' || direction === 'both') {
      // Get upline (sponsor line above)
      const upline = [];
      let currentPath = userPosition.position.path;
      
      for (let i = 0; i < parseInt(levels) && currentPath.length > 0; i++) {
        currentPath = currentPath.slice(0, -1); // Remove last character
        
        const uplinePosition = await PowerLinePosition.findOne({
          'position.path': currentPath
        }).populate('occupant.promoterId', 'personalInfo.firstName personalInfo.lastName');

        if (uplinePosition && uplinePosition.occupant.promoterId) {
          upline.push({
            nodeId: uplinePosition.position.nodeId,
            level: uplinePosition.position.level,
            member: {
              name: `${uplinePosition.occupant.promoterId.personalInfo.firstName} ${uplinePosition.occupant.promoterId.personalInfo.lastName}`,
              joinDate: uplinePosition.occupant.placementDate,
              isActive: uplinePosition.occupant.isActive
            },
            volume: uplinePosition.volume.personalVolume
          });
        }
      }
      
      hierarchy.upline = upline;
    }

    res.json({
      userPosition: {
        level: userPosition.position.level,
        positionNumber: userPosition.position.positionNumber
      },
      hierarchy,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get team hierarchy error:', error);
    res.status(500).json({ error: 'Failed to retrieve team hierarchy' });
  }
});

// Get team performance analytics
app.get('/api/team/analytics', authenticateToken, async (req, res) => {
  try {
    const { period = '30' } = req.query; // days
    const startDate = new Date(Date.now() - parseInt(period) * 24 * 60 * 60 * 1000);

    // Get team momentum
    const momentum = await Commission.calculateTeamMomentum(24);
    
    // Get top performers in team
    const topPerformers = await Commission.getTopEarners(startDate, new Date(), 10);
    
    // Get team growth statistics
    const teamGrowth = await PowerLinePosition.aggregate([
      {
        $match: {
          'occupant.placementDate': { $gte: startDate },
          'occupant.isActive': true
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$occupant.placementDate' }
          },
          newMembers: { $sum: 1 },
          totalVolume: { $sum: '$volume.personalVolume' }
        }
      },
      { $sort: { '_id': 1 } }
    ]);

    // Calculate viral metrics
    const totalInvitations = await Invitation.countDocuments({
      sponsorId: req.user.promoterId,
      createdAt: { $gte: startDate }
    });

    const acceptedInvitations = await Invitation.countDocuments({
      sponsorId: req.user.promoterId,
      status: { $in: ['registered', 'qualified'] },
      createdAt: { $gte: startDate }
    });

    const viralCoefficient = totalInvitations > 0 ? (acceptedInvitations / totalInvitations) : 0;

    res.json({
      period: `${period} days`,
      momentum,
      topPerformers,
      teamGrowth,
      viralMetrics: {
        invitationsSent: totalInvitations,
        invitationsAccepted: acceptedInvitations,
        viralCoefficient: viralCoefficient.toFixed(2),
        conversionRate: ((viralCoefficient * 100).toFixed(1)) + '%'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get team analytics error:', error);
    res.status(500).json({ error: 'Failed to retrieve team analytics' });
  }
});

// ==================== SPILLOVER MANAGEMENT ROUTES ====================

// Get spillover opportunities
app.get('/api/powerline/spillover', authenticateToken, async (req, res) => {
  try {
    const availablePositions = await PowerLinePosition.findAvailableSpilloverPositions(20);
    
    const spilloverData = availablePositions.map(position => ({
      nodeId: position.position.nodeId,
      level: position.position.level,
      side: position.position.side,
      attractiveness: position.analytics.spilloverAttractiveness,
      volume: position.volume.totalGroupVolume,
      needsBalancing: Math.abs(position.volume.leftLegVolume - position.volume.rightLegVolume) > 1000,
      openSlots: {
        left: !position.treeStructure.leftChildNodeId,
        right: !position.treeStructure.rightChildNodeId
      }
    }));

    // Sort by attractiveness score
    spilloverData.sort((a, b) => b.attractiveness - a.attractiveness);

    res.json({
      availablePositions: spilloverData,
      totalOpportunities: spilloverData.length,
      recommendations: spilloverData.slice(0, 5), // Top 5 recommendations
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get spillover opportunities error:', error);
    res.status(500).json({ error: 'Failed to retrieve spillover opportunities' });
  }
});

// ==================== MEMBER PROFILE ROUTES ====================

// Get member profile and statistics
app.get('/api/member/profile', authenticateToken, async (req, res) => {
  try {
    const member = await Promoter.findById(req.user.promoterId)
      .populate('sponsorship.sponsorId', 'personalInfo.firstName personalInfo.lastName');

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const position = await PowerLinePosition.findOne({
      'occupant.promoterId': req.user.promoterId
    });

    const recentCommissions = await Commission.find({
      'participants.recipient': req.user.promoterId
    })
    .sort({ 'metadata.createdAt': -1 })
    .limit(5);

    const totalEarnings = await Commission.aggregate([
      { $match: { 'participants.recipient': req.user.promoterId } },
      { $group: { _id: null, total: { $sum: '$transaction.amount' } } }
    ]);

    res.json({
      profile: {
        id: member._id,
        name: `${member.personalInfo.firstName} ${member.personalInfo.lastName}`,
        email: member.personalInfo.email,
        phone: member.personalInfo.phone,
        joinDate: member.talkFusion.enrollmentDate,
        status: member.talkFusion.status,
        package: member.talkFusion.packageType
      },
      powerline: position ? {
        position: position.position.positionNumber,
        level: position.position.level,
        teamSize: position.treeStructure.subtreeSize,
        volume: position.volume.totalGroupVolume
      } : null,
      earnings: {
        total: totalEarnings[0]?.total || 0,
        recent: recentCommissions.map(comm => ({
          amount: comm.transaction.amount,
          type: comm.transaction.commissionType,
          date: comm.metadata.createdAt
        }))
      },
      sponsor: member.sponsorship.sponsorId ? {
        name: `${member.sponsorship.sponsorId.personalInfo.firstName} ${member.sponsorship.sponsorId.personalInfo.lastName}`
      } : null,
      viralStats: {
        invitationsSent: member.viralReplication.invitationsSent,
        invitationsAccepted: member.viralReplication.invitationsAccepted,
        viralCoefficient: member.viralReplication.viralCoefficient
      }
    });

  } catch (error) {
    console.error('Get member profile error:', error);
    res.status(500).json({ error: 'Failed to retrieve member profile' });
  }
});

// Update member profile
app.put('/api/member/profile', authenticateToken, async (req, res) => {
  try {
    const { firstName, lastName, phone, profilePhoto, communicationStyle } = req.body;

    const updateData = {};
    if (firstName) updateData['personalInfo.firstName'] = firstName;
    if (lastName) updateData['personalInfo.lastName'] = lastName;
    if (phone) updateData['personalInfo.phone'] = phone;
    if (profilePhoto) updateData['personalInfo.profilePhoto'] = profilePhoto;
    if (communicationStyle) updateData['aiPersonalization.communicationStyle'] = communicationStyle;

    const updatedMember = await Promoter.findByIdAndUpdate(
      req.user.promoterId,
      updateData,
      { new: true, runValidators: true }
    );

    res.json({
      message: 'Profile updated successfully',
      profile: {
        id: updatedMember._id,
        firstName: updatedMember.personalInfo.firstName,
        lastName: updatedMember.personalInfo.lastName,
        phone: updatedMember.personalInfo.phone,
        profilePhoto: updatedMember.personalInfo.profilePhoto
      }
    });

  } catch (error) {
    console.error('Update member profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ==================== NOTIFICATION ROUTES ====================

// Get member notifications
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const { limit = 20, unreadOnly = false } = req.query;

    // This would typically come from a notifications collection
    // For now, we'll generate based on recent activity
    const recentCommissions = await Commission.find({
      'participants.recipient': req.user.promoterId,
      'metadata.createdAt': { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    }).sort({ 'metadata.createdAt': -1 }).limit(5);

    const recentProspects = await Prospect.find({
      'assignment.assignedPromoter': req.user.promoterId,
      'metadata.createdAt': { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    }).sort({ 'metadata.createdAt': -1 }).limit(5);

    const notifications = [
      ...recentCommissions.map(comm => ({
        id: `comm_${comm._id}`,
        type: 'commission',
        title: 'New Commission Earned',
        message: `You earned $${comm.transaction.amount} from ${comm.transaction.commissionType}`,
        timestamp: comm.metadata.createdAt,
        read: false,
        data: { commissionId: comm._id }
      })),
      ...recentProspects.map(prospect => ({
        id: `prospect_${prospect._id}`,
        type: 'prospect',
        title: 'New Prospect Added',
        message: `${prospect.basicInfo.firstName} ${prospect.basicInfo.lastName} was added to your pipeline`,
        timestamp: prospect.metadata.createdAt,
        read: false,
        data: { prospectId: prospect._id }
      }))
    ];

    // Sort by timestamp
    notifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
      notifications: notifications.slice(0, limit),
      unreadCount: notifications.filter(n => !n.read).length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to retrieve notifications' });
  }
});

console.log('✅ Elena\'s Complete PowerLine API Endpoints - ALL TASKS COMPLETE!');